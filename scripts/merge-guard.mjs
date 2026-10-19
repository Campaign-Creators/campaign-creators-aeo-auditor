#!/usr/bin/env node
/**
 * merge-guard: decide whether a PR is safe to merge, and prove afterwards that it landed.
 * Ported from goalcard-project, itself from sd-surf-teams and cc-proposal-platform.
 *
 * WHY: a PR whose base is not `main` can report MERGED and never reach `main`. This repo has no CI
 * and no branch protection, and a merge to main deploys to production (Vercel), so nothing else
 * tests the MERGE result: a branch can be green against its fork point and break once main has
 * moved.
 *
 * `pre` computes the real merge with `git merge-tree --write-tree` (no merge commit is created),
 * checks it out in a throwaway worktree and runs, ON THE MERGE: npm ci, typecheck,
 * conflict-marker scan, vitest run (one worker), lint (errors in touched files may not grow; whole-repo count
 * is informational), build with placeholder env (never real keys: the build must not need them).
 * `post` proves it landed BY CONTENT: every hunk the PR changed must be on main. This repo has used
 * both squash and merge commits, and status is not evidence either way; the check covers merge,
 * rebase and squash, and a missing hunk stops the verdict.
 *
 *   node scripts/merge-guard.mjs pre  <pr>
 *   node scripts/merge-guard.mjs post <pr>
 *
 * Exit 0 only when every check passes. Dry run without GitHub: MERGE_GUARD_DRY_RUN=1 MERGE_GUARD_PR_JSON=<file with the
 * `gh pr view --json number,title,state,baseRefName,headRefName,mergeable,mergeStateStatus,
 * mergeCommit,files` output>. A refusal (wrong base, not open, conflicts) happens before any
 * install or build.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MODE = process.argv[2];
const PR = process.argv[3];

if (!['pre', 'post'].includes(MODE) || !/^\d+$/.test(PR || '')) {
  console.error('usage: node scripts/merge-guard.mjs <pre|post> <pr-number>');
  process.exit(2);
}

// `?? ''`: execSync returns null, not a string, when stdout is not piped.
const sh = (cmd, opts = {}) =>
  (execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }) ?? '').trim();
const shOk = (cmd, opts = {}) => { try { sh(cmd, opts); return true; } catch { return false; } };
// For arguments that come from GitHub (file paths): no shell, so nothing in a name is interpreted.
const gitOk = (args) => {
  try { execFileSync('git', args, { stdio: 'ignore' }); return true; } catch { return false; }
};

const REPO = 'Campaign-Creators/campaign-creators-aeo-auditor';

// Every env name the app reads, overridden with placeholders so a real key in the caller's shell
// never reaches the build or tests, and SDK clients created at module scope still construct.
// Placeholders point at nothing; no request can reach Supabase, the AI engines, Inngest or HubSpot.
const BUILD_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_URL: 'http://127.0.0.1:1',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'merge-guard-placeholder',
  SUPABASE_SERVICE_ROLE_KEY: 'merge-guard-placeholder',
  NEXT_PUBLIC_APP_URL: 'http://127.0.0.1:1',
  INTERNAL_CRAWLER_SECRET: 'merge-guard-placeholder',
  ANTHROPIC_API_KEY: 'merge-guard-placeholder',
  OPENAI_API_KEY: 'merge-guard-placeholder',
  PERPLEXITY_API_KEY: 'merge-guard-placeholder',
  SERPAPI_API_KEY: 'merge-guard-placeholder',
  INNGEST_EVENT_KEY: 'merge-guard-placeholder',
  INNGEST_SIGNING_KEY: 'signkey-test-00000000',
  HUBSPOT_PRIVATE_APP_TOKEN: 'merge-guard-placeholder',
  RESEND_API_KEY: 'merge-guard-placeholder',
  NEXT_TELEMETRY_DISABLED: '1',
};

// The caller's shell may hold real credentials under names BUILD_ENV doesn't list (SDKs read
// extra variables such as auth tokens and base URLs). Drop anything that looks like one.
const SECRET_LIKE = /KEY|TOKEN|SECRET|PASSWORD|AUTH|SUPABASE|ANTHROPIC|OPENAI|PERPLEXITY|SERPAPI|INNGEST|HUBSPOT|RESEND|VERCEL|_URL$/i;
const callerEnvWithoutSecrets = () =>
  Object.fromEntries(Object.entries(process.env).filter(([k]) => !SECRET_LIKE.test(k)));

const check = (name, ok, detail) => {
  const mark = ok === null ? '····' : ok ? ' OK ' : 'FAIL';
  console.log(`  ${name.padEnd(30, '.')} ${String(detail).padEnd(28)} [${mark}]`);
  return ok;
};

function info() {
  const file = process.env.MERGE_GUARD_DRY_RUN === '1' ? process.env.MERGE_GUARD_PR_JSON : null;
  if (file) return JSON.parse(fs.readFileSync(file, 'utf8'));
  return JSON.parse(sh(`gh pr view ${PR} --repo ${REPO} --json number,title,state,baseRefName,headRefName,mergeable,mergeStateStatus,mergeCommit,files`));
}

// A branch may be deleted after the merge; the PR ref stays. Returns the SHA of the PR head.
function fetchAll() {
  sh('git fetch origin --quiet --prune');
  sh(`git fetch origin pull/${PR}/head --quiet`);
  return sh('git rev-parse FETCH_HEAD');
}

// Errors per file, keyed by repo-relative path with forward slashes. eslint exits 1 on errors.
function lintErrors(dir, files) {
  const out = path.join(dir, `lint-${Date.now()}.json`);
  const counts = {};
  // chunks keep the command line under cmd.exe's 8191-char limit
  for (let i = 0; i < files.length; i += 40) {
    try { sh(`npx eslint -f json -o "${out}" ${files.slice(i, i + 40).map(f => `"${f}"`).join(' ')}`, { cwd: dir }); } catch {}
    try {
      for (const r of JSON.parse(fs.readFileSync(out, 'utf8'))) {
        counts[path.relative(dir, r.filePath).split(path.sep).join('/')] = r.errorCount;
      }
    } catch {}
    try { fs.rmSync(out, { force: true }); } catch {}
  }
  return counts;
}

function pre() {
  const pr = info();
  console.log(`\nPR #${pr.number}  ${pr.title}\n`);
  let fatal = false;

  if (!check('base branch is main', pr.baseRefName === 'main', pr.baseRefName)) {
    console.log(`\n  A PR based on '${pr.baseRefName}' can report MERGED and never reach main.`);
    console.log(`  Re-target it first:  gh pr edit ${PR} --repo ${REPO} --base main\n`);
    fatal = true;
  }
  check('state is OPEN', pr.state === 'OPEN', pr.state) || (fatal = true);
  check('mergeable', pr.mergeable === 'MERGEABLE', `${pr.mergeable} / ${pr.mergeStateStatus}`) || (fatal = true);
  if (fatal) return verdict(false, 'fix the above before merging');

  const head = fetchAll();
  let tree;
  try {
    tree = sh(`git merge-tree --write-tree origin/main ${head}`).split('\n')[0].trim();
    check('merges onto main', true, 'no conflicts');
  } catch (e) {
    check('merges onto main', false, 'CONFLICTS');
    console.log(((e.stdout || '') + (e.stderr || '')).split('\n').slice(0, 12).map(l => '      ' + l).join('\n'));
    return verdict(false, 'resolve conflicts first');
  }

  const probe = sh(`git commit-tree ${tree} -p origin/main -p ${head} -m "merge-guard probe for #${PR}"`);
  const dir = path.join(os.tmpdir(), `merge-guard-${PR}-${Date.now()}`);
  let ok = true;
  const step = (name, cmd, passRe, env) => {
    let out = '';
    let good = true;
    try { out = sh(cmd, { cwd: dir, timeout: 1200000, ...(env && { env: { ...callerEnvWithoutSecrets(), ...env } }) }); }
    catch (e) { good = false; out = (e.stdout || '') + (e.stderr || ''); }
    const m = passRe && out.match(passRe);
    ok = check(name, good, good ? (m ? m[0] : 'ok') : 'FAILED') && ok;
    if (!good) console.log(out.split('\n').slice(-16).map(l => '      ' + l).join('\n'));
    return good;
  };
  try {
    sh(`git worktree add --detach --quiet "${dir}" ${probe}`);

    // Always a real install: Turbopack refuses a node_modules junction that points outside the
    // worktree ("Symlink [project]/node_modules is invalid"), so reuse made the build fail.
    step('npm ci', 'npm ci --no-audit --no-fund');
    step('typecheck ON THE MERGE', 'npx tsc --noEmit');
    // One worker keeps memory use low.
    step('vitest run ON THE MERGE', 'npx vitest run --maxWorkers=1', /Tests +\d+ passed/, BUILD_ENV);
    // git grep exits 1 when nothing matches; any other exit is an error, not a pass.
    let markers = '';
    let grepFailed = false;
    try { markers = sh(`git grep -nE "^(<<<<<<<|>>>>>>>)( |$)" ${probe} -- . ":!*.md"`); }
    catch (e) { grepFailed = e.status !== 1; }
    ok = check('no conflict markers', !markers && !grepFailed,
      grepFailed ? 'git grep FAILED' : markers ? markers.split('\n')[0].slice(0, 28) : 'none') && ok;
    // main carries lint errors (most in design/handoff), so a clean-file gate would block every PR that touches an old
    // file. Blocking: a touched file may not have MORE errors than it has on main.
    const touched = sh(`git diff --name-only --diff-filter=d origin/main ${probe}`).split('\n')
      .filter(f => /\.(m?[jt]sx?)$/.test(f));
    const safeName = /^[\w@.\/\[\]() -]+$/; // app routes use [] and (); refuse anything shell-active
    const odd = touched.filter(f => !safeName.test(f));
    if (odd.length) ok = check('lint touched files', false, `odd filename: ${odd[0]}`) && ok;
    else if (touched.length) {
      const onMerge = lintErrors(dir, touched);
      const onMain = touched.filter(f => shOk(`git cat-file -e origin/main:"${f}"`));
      if (onMain.length) sh(`git checkout origin/main -- ${onMain.map(f => `"${f}"`).join(' ')}`, { cwd: dir });
      const before = onMain.length ? lintErrors(dir, onMain) : {};
      sh(`git checkout ${probe} -- .`, { cwd: dir });
      // A file with no result means eslint crashed or the keys didn't match: fail, don't pass silently.
      const unread = [...touched.filter(f => !(f in onMerge)), ...onMain.filter(f => !(f in before))];
      const worse = touched.filter(f => (onMerge[f] ?? 0) > (before[f] ?? 0));
      const total = touched.reduce((n, f) => n + (onMerge[f] ?? 0), 0);
      ok = check('lint touched files', worse.length === 0 && unread.length === 0,
        unread.length ? `no lint result: ${unread[0]}` : worse.length ? `more errors: ${worse[0]}` : `${total} errors, none new`) && ok;
      for (const f of worse.slice(0, 10)) console.log(`      ${f}: ${before[f] ?? 0} -> ${onMerge[f]}`);
    } else check('lint touched files', true, 'no JS/TS files touched');
    try { sh('npx eslint -f json -o lint-all.json', { cwd: dir }); } catch {}
    try {
      const all = JSON.parse(fs.readFileSync(path.join(dir, 'lint-all.json'), 'utf8'));
      check('lint whole repo (info)', null, `${all.reduce((n, f) => n + f.errorCount, 0)} errors`);
    } catch { check('lint whole repo (info)', null, 'not read'); }
    step('build ON THE MERGE', 'npm run build', null, BUILD_ENV);
  } finally {
    try { sh(`git worktree remove --force "${dir}"`); } catch {}
    // Windows keeps files open for a moment after next/node exit; retry before giving up.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 }); } catch {}
    try { sh('git worktree prune'); } catch {}
    if (fs.existsSync(dir)) console.log(`  WARNING: could not remove ${dir}; delete it by hand (Windows may hold files open).`);
  }

  verdict(ok, ok
    ? `Merge with:  gh pr merge ${PR} --repo ${REPO} --merge --match-head-commit ${head}   then:   node scripts/merge-guard.mjs post ${PR}`
    : 'the merge result is broken even though the branch may be green');
}

// True when every hunk the PR itself changed is on main: the PR's own diff (fork point to head,
// lockfile excluded) must reverse-apply cleanly to main's tree. Comparing whole files instead fails
// whenever main moved on in those files after the branch was cut, e.g. a branch that predates
// another PR touching the same package.json. `target` is the merge commit when it is on main (so
// later PRs that rewrite the same lines don't fail an old check), otherwise main itself.
function prChangesOnMain(head, mergeSha, target) {
  const before = mergeSha && gitOk(['cat-file', '-e', `${mergeSha}^1`]) ? `${mergeSha}^1` : 'origin/main';
  // No shell: cmd.exe on Windows treats the `^` in `<sha>^1` as an escape character.
  const base = execFileSync('git', ['merge-base', head, before], { encoding: 'utf8' }).trim();
  // Plumbing diff, kept as raw bytes: no textconv, external diff, colour or prefix settings from the
  // caller's git config, and no re-encoding of non-UTF-8 files, can change the patch.
  const patch = execFileSync('git', ['diff-tree', '-p', '--binary', '--no-color', '--no-ext-diff', '--no-textconv',
    '--src-prefix=a/', '--dst-prefix=b/', base, head, '--', '.', ':(exclude)package-lock.json'],
  { maxBuffer: 256 * 1024 * 1024 });
  if (patch.length === 0) return { ok: false, unverifiable: true, detail: 'no changes to compare' }; // no evidence
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-guard-post-'));
  try {
    const patchFile = path.join(tmp, 'pr.patch');
    fs.writeFileSync(patchFile, patch);
    // A throwaway index holding main's tree, so the check never touches the caller's checkout.
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, 'index') };
    execFileSync('git', ['read-tree', target], { env, stdio: 'ignore' });
    try {
      execFileSync('git', ['apply', '--cached', '--check', '-R', patchFile], { env, stdio: 'ignore' });
      return { ok: true, detail: `all hunks ${base.slice(0, 7)}..${head.slice(0, 7)}` };
    } catch {
      return { ok: false, detail: 'some hunks missing' };
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function post() {
  const pr = info();
  console.log(`\nPR #${pr.number}  ${pr.title}\n`);
  const head = fetchAll();
  let ok = check('reports merged', pr.state === 'MERGED', pr.state);

  // Content, not status. Required: every hunk the PR changed is on main, which holds for merge,
  // rebase and squash alike. Ancestry and `git cherry` are shown for context only.
  const sha = pr.mergeCommit?.oid;
  const ancestor = !!sha && shOk(`git merge-base --is-ancestor ${sha} origin/main`);
  const unmerged = sh(`git cherry origin/main ${head}`).split('\n').filter(l => l.startsWith('+')).length;
  ok = check('base branch is main', pr.baseRefName === 'main', pr.baseRefName) && ok;
  check('merge commit on main', ancestor, sha ? sha.slice(0, 8) : 'none');
  check('patches in main (cherry)', unmerged === 0, `${unmerged} not in main`);
  const hunks = prChangesOnMain(head, sha, ancestor ? sha : 'origin/main');
  ok = check('PR changes on main', hunks.ok, hunks.detail) && ok;
  if (!hunks.ok && !hunks.unverifiable) console.log('      (or a later commit on main changed those lines: inspect before re-opening)');
  ok = check('LANDED BY CONTENT', ok, ok ? 'yes' : 'NO') && ok;

  if (!ok && pr.state !== 'MERGED') return verdict(false, `not merged yet (state ${pr.state})`);
  // An empty diff (lockfile-only PR, or a merge commit we can't read) is no evidence either way:
  // stop, but don't advise re-opening work that may well have landed.
  if (hunks.unverifiable) return verdict(false, `cannot verify by content (${hunks.detail}); check main by hand before acting`);
  verdict(ok, ok ? 'landed' : `NOT on main. The branch still has the work:\n      gh pr create --head ${pr.headRefName} --base main`);
}

function verdict(ok, note) {
  console.log(`\n  VERDICT: ${ok ? 'PASS' : 'STOP'}`);
  if (note) console.log(`  ${note}`);
  console.log('');
  process.exit(ok ? 0 : 1);
}

try { (MODE === 'pre' ? pre : post)(); }
catch (e) { console.error('\nmerge-guard failed to run:', e.message, '\n'); process.exit(2); }
