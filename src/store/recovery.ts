import type { Param } from "../db/database.js";

/**
 * Statements that settle work a stopped process left unfinished. Jobs with a live scheduler
 * lease are left alone, because another process is still running them. The order matters: a
 * wake-up is interrupted once its job no longer claims it.
 */
export function recoveryStatements(instance: string, now: number): [string, Param[]][] {
  return [
    ["UPDATE inbox SET status='pending' WHERE instance=? AND status='scheduled'", [instance]],
    [
      "UPDATE inbox SET status='uncertain',version=version+1 WHERE instance=? " +
        "AND status IN ('dispatching','running','delivering','cancelling')",
      [instance],
    ],
    [
      "UPDATE tasks SET status='interrupted',finished=? WHERE instance=? AND status='running'",
      [now, instance],
    ],
    [
      "UPDATE jobs SET running=0,last_status='interrupted',last_answer=NULL,version=version+1 " +
        "WHERE instance=? AND running=1 AND NOT EXISTS " +
        "(SELECT 1 FROM scheduler_leases WHERE instance=? AND expires>?)",
      [instance, instance, now],
    ],
    [
      "UPDATE job_wakeups SET status='interrupted',finished=? WHERE instance=? AND status='running' " +
        "AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.instance=job_wakeups.instance " +
        "AND jobs.id=job_wakeups.job AND jobs.running=1 AND jobs.last_run=job_wakeups.claimed)",
      [now, instance],
    ],
    [
      "UPDATE delegations SET status='interrupted',finished=?,version=version+1 " +
        "WHERE instance=? AND status='running'",
      [now, instance],
    ],
    [
      "UPDATE approvals SET decision='denied',source='restart',version=version+1 " +
        "WHERE instance=? AND decision IS NULL",
      [instance],
    ],
  ];
}
