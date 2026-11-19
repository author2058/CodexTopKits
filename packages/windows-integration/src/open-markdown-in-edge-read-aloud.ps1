[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)] [string]$LiteralPath
)

$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

if ([System.IO.Path]::GetExtension($LiteralPath) -ine '.md') {
    throw 'This command only accepts Markdown (.md) files.'
}

$item = Get-Item -LiteralPath $LiteralPath -ErrorAction Stop
$edgeCandidates = @(@(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { Test-Path -LiteralPath $_ })
if ($edgeCandidates.Count -eq 0) { throw 'Microsoft Edge was not found.' }

$edgePath = $edgeCandidates[0]
$fileUri = [Uri]::new($item.FullName).AbsoluteUri
[void](Start-Process -FilePath $edgePath -ArgumentList @('--new-window', $fileUri))

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class CodexEdgeReadAloudNative {
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint source, uint target, bool attach);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
    private static INPUT Key(ushort key, bool up) { return new INPUT { type = 1, U = new InputUnion { ki = new KEYBDINPUT { wVk = key, dwFlags = up ? 2u : 0u } } }; }
    public static uint SendReadAloudShortcut() {
        INPUT[] inputs = new INPUT[] { Key(0x11, false), Key(0x10, false), Key(0x55, false), Key(0x55, true), Key(0x10, true), Key(0x11, true) };
        return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }
    public static void ForceForeground(IntPtr hWnd) {
        ShowWindowAsync(hWnd, 9);
        IntPtr foreground = GetForegroundWindow();
        uint currentThread = GetCurrentThreadId();
        uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, IntPtr.Zero);
        uint targetThread = GetWindowThreadProcessId(hWnd, IntPtr.Zero);
        bool attachedForeground = foregroundThread != 0 && foregroundThread != currentThread && AttachThreadInput(currentThread, foregroundThread, true);
        bool attachedTarget = targetThread != 0 && targetThread != currentThread && AttachThreadInput(currentThread, targetThread, true);
        try {
            BringWindowToTop(hWnd);
            SetActiveWindow(hWnd);
            SetFocus(hWnd);
            SetForegroundWindow(hWnd);
            SwitchToThisWindow(hWnd, true);
        } finally {
            if (attachedTarget) AttachThreadInput(currentThread, targetThread, false);
            if (attachedForeground) AttachThreadInput(currentThread, foregroundThread, false);
        }
    }
}
'@
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$deadline = (Get-Date).AddSeconds(20)
$shell = New-Object -ComObject WScript.Shell
$target = $null
while ((Get-Date) -lt $deadline) {
    $target = Get-Process -Name msedge -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$($item.Name)*" } |
        Select-Object -First 1
    if ($target) { break }
    Start-Sleep -Milliseconds 250
}

if (-not $target) {
    throw "Edge opened the Markdown file, but its document window did not become ready within 20 seconds."
}

[void][CodexEdgeReadAloudNative]::ShowWindowAsync($target.MainWindowHandle, 9)
[void]$shell.AppActivate($item.Name)
[void]$shell.AppActivate($target.Id)
[CodexEdgeReadAloudNative]::ForceForeground($target.MainWindowHandle)
for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
    if ([CodexEdgeReadAloudNative]::GetForegroundWindow() -eq $target.MainWindowHandle) { break }
    [void]$shell.AppActivate($item.Name)
    [void]$shell.AppActivate($target.Id)
    [CodexEdgeReadAloudNative]::ForceForeground($target.MainWindowHandle)
    Start-Sleep -Milliseconds 100
}
if ([CodexEdgeReadAloudNative]::GetForegroundWindow() -ne $target.MainWindowHandle) {
    throw "Edge opened the Markdown file, but Windows did not allow its window to become foreground."
}

Start-Sleep -Milliseconds 250
$shell.SendKeys('^0')
Start-Sleep -Milliseconds 100
for ($index = 0; $index -lt 5; $index += 1) {
    $shell.SendKeys('^{+}')
    Start-Sleep -Milliseconds 80
}
[void]$shell.AppActivate($target.Id)
Start-Sleep -Milliseconds 200
$shell.SendKeys('^+u')

$playing = $false
$observed = @()
for ($attempt = 0; $attempt -lt 24; $attempt += 1) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($target.MainWindowHandle)
    $elements = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $observed = @($elements | ForEach-Object {
        $name = $_.Current.Name
        if ($name -match 'Pause|暂停') { [pscustomobject]@{ Name = $name; IsOffscreen = $_.Current.IsOffscreen } }
    })
    if (@($observed | Where-Object { -not $_.IsOffscreen }).Count -gt 0) { $playing = $true; break }
    Start-Sleep -Milliseconds 250
}
if (-not $playing) { throw 'Edge did not expose a visible Pause control after receiving the Read Aloud shortcut.' }

[pscustomobject]@{
    started = $true
    foregroundConfirmed = $true
    processId = $target.Id
    title = $target.MainWindowTitle
} | ConvertTo-Json -Compress
