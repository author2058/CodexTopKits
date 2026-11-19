[CmdletBinding(DefaultParameterSetName = 'List')]
param(
    [Parameter(ParameterSetName = 'Focus', Mandatory = $true)]
    [ValidateRange(1, [long]::MaxValue)]
    [long]$Handle,
    [Parameter(ParameterSetName = 'Focus', Mandatory = $true)]
    [ValidateRange(1, [uint32]::MaxValue)]
    [uint32]$ProcessId,
    [Parameter(ParameterSetName = 'List', Mandatory = $true)]
    [switch]$List,
    [Parameter(ParameterSetName = 'Foreground', Mandatory = $true)]
    [switch]$Foreground,
    [Parameter(ParameterSetName = 'Server', Mandatory = $true)]
    [switch]$Server
)

$ErrorActionPreference = 'Stop'

# The controller writes newline-delimited JSON as UTF-8.  A hidden pwsh
# process can otherwise inherit the desktop's legacy OEM/ANSI code page,
# corrupting CJK thread titles and emoji before ConvertFrom-Json sees them.
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8NoBom
[Console]::OutputEncoding = $utf8NoBom
$OutputEncoding = $utf8NoBom

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class CodexNativeWindows {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attachId, uint attachToId, bool attach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Placement {
        public uint Length, Flags, ShowCommand;
        public Point Minimum, Maximum;
        public Rect Normal;
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MonitorInfo {
        public int Size; public Rect Monitor, Work; public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPlacement(IntPtr window, ref Placement placement);
    [DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] private static extern uint GetDpiForWindow(IntPtr window);
    public static Dictionary<string, object> ReadPlacement(long handle) {
        var window = new IntPtr(handle);
        if (!IsWindow(window)) throw new InvalidOperationException("Window no longer exists: " + handle);
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not read window placement in per-monitor DPI coordinates.");
        try {
            var placement = new Placement { Length = (uint)Marshal.SizeOf(typeof(Placement)) };
            if (!GetWindowPlacement(window, ref placement)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            var monitor = new MonitorInfo { Size = Marshal.SizeOf(typeof(MonitorInfo)) };
            if (!GetMonitorInfo(MonitorFromWindow(window, 2), ref monitor)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            uint processId; GetWindowThreadProcessId(window, out processId);
            return new Dictionary<string, object> {
                { "handle", handle }, { "processId", processId },
                { "normal", new Dictionary<string, int> { { "left", placement.Normal.Left }, { "top", placement.Normal.Top }, { "right", placement.Normal.Right }, { "bottom", placement.Normal.Bottom } } },
                { "maximized", IsZoomed(window) || IsIconic(window) && (placement.Flags & 2) != 0 },
                { "monitor", monitor.Device }, { "dpi", GetDpiForWindow(window) }
            };
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    public static Dictionary<string, object> RestorePlacement(long handle, int left, int top, int right, int bottom, bool maximized) {
        var window = new IntPtr(handle);
        if (!IsWindow(window)) throw new InvalidOperationException("Window no longer exists: " + handle);
        if (right <= left || bottom <= top) throw new ArgumentException("Window dimensions must be positive.");
        var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not restore window placement in per-monitor DPI coordinates.");
        try {
            // WINDOWPLACEMENT uses workspace coordinates; read and write under
            // the same DPI context, never mix these with renderer DIP bounds.
            var placement = new Placement { Length = (uint)Marshal.SizeOf(typeof(Placement)), ShowCommand = maximized ? 3u : 4u,
                Normal = new Rect { Left = left, Top = top, Right = right, Bottom = bottom } };
            if (!SetWindowPlacement(window, ref placement)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return ReadPlacement(handle);
        } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
    }
    public static List<long> ListCodexWindows() {
        var handles = new List<long>();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            var title = new StringBuilder(512);
            GetWindowText(hWnd, title, title.Capacity);
            if (title.ToString() == "ChatGPT") handles.Add(hWnd.ToInt64());
            return true;
        }, IntPtr.Zero);
        return handles;
    }
    public static long ForegroundCodexWindow() {
        var hWnd = GetForegroundWindow();
        if (hWnd == IntPtr.Zero || !IsWindowVisible(hWnd)) return 0;
        var title = new StringBuilder(512);
        GetWindowText(hWnd, title, title.Capacity);
        return title.ToString() == "ChatGPT" ? hWnd.ToInt64() : 0;
    }
}

// WinEvent callbacks need a message pump. This thread shares the existing
// worker/pipe and observes only the HWNDs owned by the controller.
public static class CodexWindowNotifications {
    private delegate void EventCallback(IntPtr hook, uint type, IntPtr window, int objectId, int childId, uint thread, uint time);
    [StructLayout(LayoutKind.Sequential)] private struct Message { public IntPtr Window; public uint Id; public UIntPtr WParam; public IntPtr LParam; public uint Time; public CodexNativeWindows.Point Point; public uint Private; }
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, EventCallback callback, uint process, uint thread, uint flags);
    [DllImport("user32.dll")] private static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll")] private static extern int GetMessage(out Message message, IntPtr window, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool PeekMessage(out Message message, IntPtr window, uint min, uint max, uint flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostThreadMessage(uint thread, uint message, UIntPtr wParam, IntPtr lParam);
    private static readonly object Gate = new object();
    private static HashSet<long> handles = new HashSet<long>();
    private static readonly HashSet<long> dragging = new HashSet<long>();
    private static Thread thread;
    private static ManualResetEventSlim ready;
    private static uint threadId;
    private static EventCallback callback;
    private static Exception startupError;
    public static void Watch(long[] nextHandles) {
        if (startupError != null) throw startupError;
        lock (Gate) { handles = new HashSet<long>(nextHandles); }
        if (thread != null) return;
        if (nextHandles.Length == 0) return;
        uint processId;
        CodexNativeWindows.GetWindowThreadProcessId(new IntPtr(nextHandles[0]), out processId);
        if (processId == 0) throw new InvalidOperationException("Window event owner is no longer available.");
        ready = new ManualResetEventSlim();
        {
            thread = new Thread(() => {
                var hooks = new List<IntPtr>();
                try {
                    threadId = CodexNativeWindows.GetCurrentThreadId();
                    Message message; PeekMessage(out message, IntPtr.Zero, 0, 0, 0);
                    callback = OnEvent;
                    foreach (var range in new uint[][] { new uint[] { 10, 11 }, new uint[] { 22, 23 }, new uint[] { 0x800B, 0x800B } }) {
                        var hook = SetWinEventHook(range[0], range[1], IntPtr.Zero, callback, processId, 0, 0);
                        if (hook == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Window event subscription failed.");
                        hooks.Add(hook);
                    }
                    ready.Set();
                    int result;
                    while ((result = GetMessage(out message, IntPtr.Zero, 0, 0)) > 0) { }
                    if (result < 0) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                } catch (Exception error) {
                    startupError = error;
                    var message = error.ToString().Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", "\\r").Replace("\n", "\\n").Replace("\t", "\\t");
                    CodexPowerNotifications.WriteLine("{\"event\":\"window-events-failed\",\"message\":\"" + message + "\"}");
                } finally {
                    foreach (var hook in hooks) UnhookWinEvent(hook);
                    ready.Set();
                }
            });
            thread.IsBackground = true;
            thread.Start(); ready.Wait();
        }
        if (startupError != null) throw startupError;
    }
    private static void OnEvent(IntPtr hook, uint type, IntPtr window, int objectId, int childId, uint eventThread, uint time) {
        long handle = window.ToInt64();
        lock (Gate) {
            if (!handles.Contains(handle) || objectId != 0 || childId != 0) return;
            if (type == 10) { dragging.Add(handle); return; }
            if (type == 11) dragging.Remove(handle);
            else if (dragging.Contains(handle)) return;
        }
        CodexPowerNotifications.WriteLine("{\"event\":\"window-placement\",\"handle\":" + handle.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
    }
    public static void Stop() {
        if (thread == null) return;
        if (thread.IsAlive && !PostThreadMessage(threadId, 0x12, UIntPtr.Zero, IntPtr.Zero)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        thread.Join(); thread = null; callback = null;
        ready.Dispose(); ready = null;
        lock (Gate) { handles.Clear(); dragging.Clear(); }
    }
}

// Reuse this worker's lifetime and UTF-8 pipe; no polling or extra process.
public static class CodexPowerNotifications {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)]
    private delegate uint PowerCallback(IntPtr context, uint type, IntPtr setting);
    [StructLayout(LayoutKind.Sequential)]
    private struct SubscribeParameters { public IntPtr Callback; public IntPtr Context; }
    [DllImport("powrprof.dll")]
    private static extern uint PowerRegisterSuspendResumeNotification(uint flags, ref SubscribeParameters recipient, out IntPtr handle);
    [DllImport("powrprof.dll")]
    private static extern uint PowerUnregisterSuspendResumeNotification(IntPtr handle);
    private static readonly object Gate = new object();
    private static PowerCallback callback;
    private static IntPtr registration;
    private static long sequence;
    private static string lastType;
    private static long observedAt;

    public static void WriteLine(string line) {
        lock (Gate) { Console.Out.WriteLine(line); Console.Out.Flush(); }
    }
    public static Dictionary<string, object> Status() {
        lock (Gate) {
            return new Dictionary<string, object> {
                { "ready", registration != IntPtr.Zero }, { "sequence", sequence },
                { "type", lastType }, { "observedAt", observedAt }
            };
        }
    }
    public static Dictionary<string, object> Start() {
        if (registration != IntPtr.Zero) return Status();
        callback = OnPower;
        var parameters = new SubscribeParameters { Callback = Marshal.GetFunctionPointerForDelegate(callback), Context = IntPtr.Zero };
        IntPtr handle;
        uint result = PowerRegisterSuspendResumeNotification(2, ref parameters, out handle);
        if (result != 0) throw new System.ComponentModel.Win32Exception((int)result, "PowerRegisterSuspendResumeNotification failed (" + result + "): " + new System.ComponentModel.Win32Exception((int)result).Message);
        registration = handle;
        return Status();
    }
    private static uint OnPower(IntPtr context, uint type, IntPtr setting) {
        string nextType = type == 4 ? "suspend" : type == 7 || type == 18 ? "resume" : null;
        if (nextType == null) return 0;
        lock (Gate) {
            // Windows may send automatic resume followed by interactive resume.
            // They represent one boundary, not a new revocation after rearming.
            if (nextType == lastType) return 0;
            lastType = nextType;
            observedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            sequence++;
            WriteLine("{\"event\":\"power-state\",\"ready\":true,\"type\":\"" + nextType
                + "\",\"sequence\":" + sequence.ToString(System.Globalization.CultureInfo.InvariantCulture)
                + ",\"observedAt\":" + observedAt.ToString(System.Globalization.CultureInfo.InvariantCulture) + "}");
        }
        return 0;
    }
    public static void Stop() {
        if (registration == IntPtr.Zero) return;
        uint result = PowerUnregisterSuspendResumeNotification(registration);
        if (result != 0) throw new System.ComponentModel.Win32Exception((int)result, "PowerUnregisterSuspendResumeNotification failed (" + result + "): " + new System.ComponentModel.Win32Exception((int)result).Message);
        registration = IntPtr.Zero;
        callback = null;
    }
}
'@

function Find-CodexWindowsByThreadTitle {
    param([Parameter(Mandatory = $true)][string]$ThreadTitle)
    $matches = foreach ($rawHandle in [CodexNativeWindows]::ListCodexWindows()) {
        try {
            $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$rawHandle)
            $rootBounds = $root.Current.BoundingRectangle
            $condition = [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::NameProperty,
                $ThreadTitle
            )
            $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
            $header = $elements | Where-Object {
                $bounds = $_.Current.BoundingRectangle
                $controlType = $_.Current.ControlType
                $relativeLeft = $bounds.Left - $rootBounds.Left
                $relativeTop = $bounds.Top - $rootBounds.Top
                ($controlType -eq [System.Windows.Automation.ControlType]::Button -or $controlType -eq [System.Windows.Automation.ControlType]::Text) -and
                    $relativeLeft -ge 320 -and $relativeTop -ge 0 -and $relativeTop -lt 120 -and $bounds.Width -ge 60
            } | Select-Object -First 1
            if ($header) { [long]$rawHandle }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    return @($matches)
}

function Focus-CodexWindow {
    param([Parameter(Mandatory = $true)][ValidateRange(1, [long]::MaxValue)][long]$WindowHandle,
        [Parameter(Mandatory = $true)][ValidateRange(1, [uint32]::MaxValue)][uint32]$ExpectedProcessId)
    $nativeHandle = [IntPtr]$WindowHandle
    if (-not [CodexNativeWindows]::IsWindow($nativeHandle)) { throw 'Codex window handle is no longer valid.' }
    $owner = [uint32]0
    [void][CodexNativeWindows]::GetWindowThreadProcessId($nativeHandle, [ref]$owner)
    if ($owner -ne $ExpectedProcessId) { throw 'Codex window belongs to a different process.' }
# SW_RESTORE is only needed for a minimized window. Calling it on an already
# maximized window turns it back into a normal-sized one.
    if ([CodexNativeWindows]::IsIconic($nativeHandle)) { [void][CodexNativeWindows]::ShowWindow($nativeHandle, 9) }
    $foregroundHandle = [CodexNativeWindows]::GetForegroundWindow()
    $foregroundProcess = [uint32]0
    $targetProcess = [uint32]0
    $foregroundThread = if ($foregroundHandle -ne [IntPtr]::Zero) { [CodexNativeWindows]::GetWindowThreadProcessId($foregroundHandle, [ref]$foregroundProcess) } else { 0 }
    $targetThread = [CodexNativeWindows]::GetWindowThreadProcessId($nativeHandle, [ref]$targetProcess)
    $currentThread = [CodexNativeWindows]::GetCurrentThreadId()
    $attachedForeground = $false
    $attachedTarget = $false
    try {
        if ($foregroundThread -and $foregroundThread -ne $currentThread) { $attachedForeground = [CodexNativeWindows]::AttachThreadInput($currentThread, $foregroundThread, $true) }
        if ($targetThread -and $targetThread -ne $currentThread) { $attachedTarget = [CodexNativeWindows]::AttachThreadInput($currentThread, $targetThread, $true) }
        [void][CodexNativeWindows]::BringWindowToTop($nativeHandle)
        if (-not [CodexNativeWindows]::SetForegroundWindow($nativeHandle)) { throw 'Windows refused to foreground the Codex window.' }
    } finally {
        if ($attachedTarget) { [void][CodexNativeWindows]::AttachThreadInput($currentThread, $targetThread, $false) }
        if ($attachedForeground) { [void][CodexNativeWindows]::AttachThreadInput($currentThread, $foregroundThread, $false) }
    }
    return @{ focused = $WindowHandle; maximized = [CodexNativeWindows]::IsZoomed($nativeHandle) }
}

function Find-CodexWindowsByTarget {
    param([Parameter(Mandatory)][string]$TargetId, [Parameter(Mandatory)][int]$ExpectedProcessId)
    $owner = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ExpectedProcessId)
    $roots = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, $owner)
    $marker = [System.Windows.Automation.PropertyCondition]::new([System.Windows.Automation.AutomationElement]::AutomationIdProperty, ('cdtk-window-' + $TargetId))
    $handles = foreach ($root in $roots) {
        try {
            if ($null -ne $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $marker)) { [long]$root.Current.NativeWindowHandle }
        } catch [System.Windows.Automation.ElementNotAvailableException] {
            continue
        }
    }
    return @($handles)
}

if ($PSCmdlet.ParameterSetName -eq 'Server') {
    try {
    while ($null -ne ($line = [Console]::In.ReadLine())) {
        $id = $null
        try {
            $request = $line | ConvertFrom-Json -AsHashtable
            $id = $request.id
            $result = switch ($request.action) {
                'ping' { @{ ready = $true; probe = $request.probe; inputEncoding = [Console]::InputEncoding.WebName; outputEncoding = [Console]::OutputEncoding.WebName } }
                'power-subscribe' { [CodexPowerNotifications]::Start() }
                'power-status' { [CodexPowerNotifications]::Status() }
                'list' { @{ handles = @([CodexNativeWindows]::ListCodexWindows()) } }
                'window-watch' {
                    [CodexWindowNotifications]::Watch([long[]]$request.handles)
                    @{ ready = $true }
                }
                'placement' { [CodexNativeWindows]::ReadPlacement([long]$request.handle) }
                'place' {
                    $normal = $request.placement.normal
                    [CodexNativeWindows]::RestorePlacement([long]$request.handle, [int]$normal.left, [int]$normal.top, [int]$normal.right, [int]$normal.bottom, [bool]$request.placement.maximized)
                }
                'find' {
                    if ($request.title -isnot [string] -or [string]::IsNullOrWhiteSpace($request.title) -or $request.title.Length -gt 240) { throw 'Find request requires a thread title.' }
                    @{ handles = @(Find-CodexWindowsByThreadTitle -ThreadTitle $request.title) }
                }
                'find-target' {
                    if ($request.targetId -isnot [string] -or [string]::IsNullOrEmpty($request.targetId) -or ($request.processId -isnot [int] -and $request.processId -isnot [long]) -or $request.processId -le 0) { throw 'Target lookup requires a target ID and process ID.' }
                    @{ handles = @(Find-CodexWindowsByTarget -TargetId $request.targetId -ExpectedProcessId ([int]$request.processId)) }
                }
                'foreground' { @{ handle = [CodexNativeWindows]::ForegroundCodexWindow() } }
                'focus' {
                    if ($request.handle -isnot [long] -and $request.handle -isnot [int]) { throw 'Focus request requires an integer handle.' }
                    if (($request.processId -isnot [long] -and $request.processId -isnot [int]) -or $request.processId -le 0) { throw 'Focus request requires a process ID.' }
                    Focus-CodexWindow -WindowHandle ([long]$request.handle) -ExpectedProcessId ([uint32]$request.processId)
                }
                default { throw 'Unknown worker action.' }
            }
            $response = @{ id = $id; ok = $true; result = $result } | ConvertTo-Json -Compress -Depth 6
            [CodexPowerNotifications]::WriteLine($response)
        } catch {
            $response = @{ id = $id; ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
            [CodexPowerNotifications]::WriteLine($response)
        }
        [Console]::Out.Flush()
    }
    } finally { [CodexWindowNotifications]::Stop(); [CodexPowerNotifications]::Stop() }
    exit 0
}

if ($PSCmdlet.ParameterSetName -eq 'List') { [CodexNativeWindows]::ListCodexWindows() | ConvertTo-Json -Compress; exit 0 }
if ($PSCmdlet.ParameterSetName -eq 'Foreground') { @{ handle = [CodexNativeWindows]::ForegroundCodexWindow() } | ConvertTo-Json -Compress; exit 0 }
Focus-CodexWindow -WindowHandle $Handle -ExpectedProcessId $ProcessId | ConvertTo-Json -Compress
