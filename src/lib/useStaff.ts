'use client';

import { useEffect, useState } from 'react';
import { staffAuthHeader } from '@/lib/staffClient';

/** True once the server has confirmed this browser's sign-in is on the staff list. */
export function useStaff(): boolean {
  const [staff, setStaff] = useState(false);
  useEffect(() => {
    let live = true;
    (async () => {
      const auth = await staffAuthHeader();
      if (!auth.Authorization) return;
      try {
        const res = await fetch('/api/staff', { headers: auth });
        const data = (await res.json()) as { staff?: boolean };
        if (live && data.staff) setStaff(true);
      } catch {
        // stays public
      }
    })();
    return () => { live = false; };
  }, []);
  return staff;
}
