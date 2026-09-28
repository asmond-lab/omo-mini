import { spawn } from "node:child_process";

// Snapshot this test's Windows RPC process tree while its parent PID is still
// alive. Keep real OS process handles open across taskkill; a PID lookup after
// taskkill can refer to a different process or precede handle closure.
export async function stopOwnedWindowsTree(pid: number): Promise<void> {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$owner = [int]$env:OMO_OVERFLOW_OWNER_PID
$rows = @(Get-CimInstance Win32_Process)
$head = $rows | Where-Object { [int]$_.ProcessId -eq $owner } | Select-Object -First 1
if ($null -eq $head) { throw 'Owned RPC parent exited before tree snapshot' }
$birth = [System.Collections.Generic.Dictionary[int,long]]::new()
$birth.Add($owner, ([DateTimeOffset]$head.CreationDate).ToUnixTimeMilliseconds())
for ($i = 0; $i -lt 64; $i++) {
  $count = $birth.Count
  foreach ($row in $rows) {
    $id = [int]$row.ProcessId; $parent = [int]$row.ParentProcessId
    if (-not $birth.ContainsKey($parent) -or $birth.ContainsKey($id)) { continue }
    $created = ([DateTimeOffset]$row.CreationDate).ToUnixTimeMilliseconds()
    if ($created -ge $birth[$parent]) { $birth.Add($id, $created) }
  }
  if ($birth.Count -gt 64) { throw 'Owned RPC tree exceeded 64 processes' }
  if ($birth.Count -eq $count) { break }
}
$held = @()
try {
  foreach ($id in $birth.Keys) {
    try { $proc = [System.Diagnostics.Process]::GetProcessById($id) }
    catch [System.ArgumentException] {
      if ($id -eq $owner) { throw }
      continue # A short-lived descendant exited before handle capture.
    }
    $safe = $proc.SafeHandle
    if ($safe.IsInvalid -or $safe.IsClosed -or
        [Math]::Abs(([DateTimeOffset]$proc.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() - $birth[$id]) -gt 2000) {
      throw "Owned RPC PID changed or handle invalid: $id"
    }
    $held += [pscustomobject]@{ process=$proc; safeHandle=$safe; pid=$id }
  }
  [Console]::WriteLine('READY'); [Console]::Out.Flush()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  $unclosed = @()
  foreach ($entry in $held) {
    $remaining = 10000 - [int]$clock.ElapsedMilliseconds
    if ($remaining -le 0 -or -not $entry.process.WaitForExit($remaining)) { $unclosed += $entry.pid }
  }
  if ($unclosed.Count -ne 0) { throw "Owned RPC process handles remained: $($unclosed -join ',')" }
  [Console]::WriteLine('CLOSED'); [Console]::Out.Flush()
} finally { foreach ($entry in $held) { $entry.process.Dispose() } }
`;
  const watcher = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script],
    { stdio: ["ignore", "pipe", "pipe"] satisfies ["ignore", "pipe", "pipe"], windowsHide: true, env: { ...process.env, OMO_OVERFLOW_OWNER_PID: String(pid) } });
  let output = "", errors = "", ready = false, closed = false;
  const started = Promise.withResolvers<void>();
  const exited = new Promise<number | null>((accept, reject) => {
    watcher.once("error", reject); watcher.once("close", accept);
  });
  watcher.stderr.on("data", chunk => { errors += chunk.toString(); errors = errors.slice(-1200); });
  watcher.stdout.on("data", chunk => {
    output += chunk.toString();
    if (output.length > 8192) { started.reject(Error("Owned RPC watcher output exceeded 8 KiB")); return; }
    let end: number;
    while ((end = output.indexOf("\n")) >= 0) {
      const line = output.slice(0, end).trim(); output = output.slice(end + 1);
      if (line === "READY" && !ready) { ready = true; started.resolve(); }
      if (line === "CLOSED") closed = true;
    }
  });
  const bounded = async <T>(pending: Promise<T>, ms: number, label: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([pending, new Promise<never>((_accept, reject) => {
      timer = setTimeout(() => reject(Error(label)), ms);
    })]); } finally { if (timer) clearTimeout(timer); }
  };
  let killer: ReturnType<typeof spawn> | undefined, killerClosed: Promise<number | null> | undefined;
  try {
    await bounded(Promise.race([started.promise, exited.then(code => { throw Error(`Owned RPC watcher exited before ready (${code}): ${errors}`); })]),
      10000, "Owned RPC watcher not ready");
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", "/F"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    killer = taskkill;
    let killOutput = Buffer.alloc(0), killErrors = Buffer.alloc(0);
    taskkill.stdout.on("data", chunk => { killOutput = Buffer.concat([killOutput, chunk]).subarray(-4096); });
    taskkill.stderr.on("data", chunk => { killErrors = Buffer.concat([killErrors, chunk]).subarray(-4096); });
    killerClosed = new Promise<number | null>((accept, reject) => { taskkill.once("error", reject); taskkill.once("close", accept); });
    const code = await bounded(killerClosed, 10000, "Owned RPC tree kill timed out");
    const killReport = `taskkill status=${code}, signal=${taskkill.signalCode ?? "none"}, stdout=${killOutput.toString("utf8")}, stderr=${killErrors.toString("utf8")}, stdoutBase64=${killOutput.toString("base64")}, stderrBase64=${killErrors.toString("base64")}`;
    // Command status alone cannot establish whether its targets are still alive.
    // The watcher must attest exit of EVERY creation-checked, pre-opened handle.
    if (await bounded(exited, 15000, "Owned RPC watcher did not close") !== 0 || !closed)
      throw Error(`Owned RPC process exit unconfirmed (${killReport}): ${errors}`);
    if (code !== 0) console.error(`Owned RPC captured tree closed despite ${killReport}`);
  } catch (error) {
    const failures: unknown[] = [error];
    if (killer && killer.exitCode === null && killer.signalCode === null) killer.kill();
    if (killerClosed) {
      try { await bounded(killerClosed, 5000, "Owned taskkill close unconfirmed"); }
      catch (failure) { failures.push(failure); }
    }
    watcher.kill();
    try { await bounded(exited, 5000, "Owned RPC watcher close unconfirmed"); }
    catch (failure) { failures.push(failure); }
    // Never taskkill a bare PID after an unverified owner snapshot: it could
    // have been recycled. The test's direct child handle is cleaned below.
    if (failures.length > 1) throw new AggregateError(failures, "Owned RPC cleanup failed");
    throw error;
  }
}
