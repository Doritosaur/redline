// Synchronous "analytics" work right after first paint -> long task / Total Blocking Time.
export function startAnalytics(): void {
  if ((window as { FIXTURE_FAST?: boolean }).FIXTURE_FAST) return;
  requestAnimationFrame(() => {
    setTimeout(() => {
      const end = performance.now() + 450;
      let checksum = 0;
      while (performance.now() < end) checksum += Math.random();
      (window as { analyticsChecksum?: number }).analyticsChecksum = checksum;
    }, 0);
  });
}
