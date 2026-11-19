param([int]$ToolkitProcessId = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
. (Join-Path $PSScriptRoot 'codex-processes.ps1')
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Net;
using System.Runtime.InteropServices;
public static class CodexTrafficConnections {
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr data, ref int size, bool order, int family, int tableClass, uint reserved);
    [DllImport("iphlpapi.dll")] static extern uint GetExtendedUdpTable(IntPtr data, ref int size, bool order, int family, int tableClass, uint reserved);
    static int Port(IntPtr row, int offset) { return Marshal.ReadByte(row, offset) * 256 + Marshal.ReadByte(row, offset + 1); }
    static string Address(IntPtr row, int offset, bool ipv6, int portOffset) {
        var bytes = new byte[ipv6 ? 16 : 4]; Marshal.Copy(IntPtr.Add(row, offset), bytes, 0, bytes.Length);
        string address = new IPAddress(bytes).ToString(); return (ipv6 ? "[" + address + "]" : address) + ":" + Port(row, portOffset);
    }
    public static object[] Read(int[] processIds) {
        var wanted = new HashSet<int>(processIds); var rows = new List<object>();
        foreach (bool tcp in new[] { true, false }) foreach (bool ipv6 in new[] { false, true }) {
            int size = 0, family = ipv6 ? 23 : 2;
            uint result = tcp ? GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 5, 0) : GetExtendedUdpTable(IntPtr.Zero, ref size, false, family, 1, 0);
            if (result != 122 && result != 0) throw new System.ComponentModel.Win32Exception((int)result);
            if (size == 0) continue;
            IntPtr data = Marshal.AllocHGlobal(size);
            try {
                result = tcp ? GetExtendedTcpTable(data, ref size, false, family, 5, 0) : GetExtendedUdpTable(data, ref size, false, family, 1, 0);
                if (result != 0) throw new System.ComponentModel.Win32Exception((int)result);
                int count = Marshal.ReadInt32(data), stride = tcp ? (ipv6 ? 56 : 24) : (ipv6 ? 28 : 12);
                if (count < 0 || 4L + (long)count * stride > size) throw new Exception("Unexpected Windows connection table layout.");
                for (int i = 0; i < count; i++) {
                    IntPtr row = IntPtr.Add(data, 4 + i * stride);
                    int pidOffset = tcp ? (ipv6 ? 52 : 20) : (ipv6 ? 24 : 8), pid = Marshal.ReadInt32(row, pidOffset);
                    if (!wanted.Contains(pid)) continue;
                    rows.Add(new { pid, protocol = tcp ? (ipv6 ? "TCP6" : "TCP4") : (ipv6 ? "UDP6" : "UDP4"),
                        local = Address(row, tcp && !ipv6 ? 4 : 0, ipv6, ipv6 ? 20 : (tcp ? 8 : 4)),
                        remote = tcp ? Address(row, ipv6 ? 24 : 12, ipv6, ipv6 ? 44 : 16) : null,
                        state = tcp ? ((System.Net.NetworkInformation.TcpState)Marshal.ReadInt32(row, ipv6 ? 48 : 0)).ToString() : "Bound" });
                }
            } finally { Marshal.FreeHGlobal(data); }
        }
        return rows.ToArray();
    }
}
'@
$processes = @(Get-CodexTrafficProcesses -ToolkitProcessId $ToolkitProcessId)
$names = @{}
foreach ($item in $processes) { $names[[int]$item.ProcessId] = $item.Name }
$rows = @([CodexTrafficConnections]::Read([int[]]@($processes.ProcessId)) | ForEach-Object {
    @{ pid = $_.pid; process = $names[[int]$_.pid]; protocol = $_.protocol; local = $_.local; remote = $_.remote; state = $_.state }
})
ConvertTo-Json -InputObject $rows -Compress -Depth 4
