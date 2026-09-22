import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest/client';
import { runAudit } from '@/lib/inngest/functions';

/**
 * Each Inngest step runs as one invocation of this route, so the crawl step is
 * bounded by this value. Without it the route ran under the platform default,
 * which is far below what a crawl needs: the process was killed mid-step, the
 * handler's catch block never ran, and the audit sat in `processing` forever.
 * 14 rows are stuck that way and none has ever been marked failed.
 *
 * The crawl itself now stops at a budget below this ceiling (CRAWL_BUDGET_MS in
 * lib/inngest/functions.ts), so the step finishes on its own terms and stores
 * what it managed to read. This is the backstop, not the mechanism.
 *
 * See docs/audit/01-crawler.md F5.
 */
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runAudit],
});
