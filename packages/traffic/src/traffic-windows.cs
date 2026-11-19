using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;

// Kernel network metadata only. No packet payload, TLS keys or request bodies.
public sealed class CodexWindowsTraffic : IDisposable {
    static readonly Guid Provider = new Guid("7dd42a49-5329-4832-8dfd-43d979153a88");
    readonly object gate = new object();
    const string name = "CodexDynamicTheme-Network";
    readonly string run = name + "-" + Guid.NewGuid().ToString("N");
    static int processOwner;
    Mutex owner;
    bool ownsProcess, ownsMutex, recoveredOrphan;
    readonly Dictionary<string, Row> pending = new Dictionary<string, Row>();
    Dictionary<int, string> processes = new Dictionary<int, string>();
    readonly EventCallback callback;
    ulong session, consumer = ulong.MaxValue;
    IntPtr properties;
    Task<uint> reader;
    Exception failure;
    long up, down, localUp, localDown, events;
    public string SessionName { get { return name; } }

    public sealed class Row {
        public int pid; public string process, protocol, remote; public bool loopback;
        public long up, down, events;
    }
    public sealed class Snapshot {
        public string session, traceSession; public bool recoveredOrphan; public long up, down, localUp, localDown, events;
        public uint eventsLost, buffersLost; public Row[] rows;
    }
    public sealed class Packet {
        public int pid; public uint size; public bool send, loopback; public string protocol, remote;
    }
    public static Packet Decode(ushort id, byte version, byte[] data) {
        bool ipv6 = id == 26 || id == 27 || id == 58 || id == 59;
        bool send = id == 10 || id == 26 || id == 42 || id == 58;
        if (!send && id != 11 && id != 27 && id != 43 && id != 59) return null;
        int length = ipv6 ? 16 : 4, portOffset = 8 + 2 * length;
        if (version != 0 || data.Length < portOffset + 4)
            throw new InvalidOperationException("Kernel-Network event schema changed: " + id + "/" + version);
        var address = new byte[length];
        // This provider reports the peer in daddr/dport for both send and receive.
        Buffer.BlockCopy(data, 8, address, 0, length);
        var ip = new IPAddress(address);
        int port = portOffset;
        return new Packet { pid = BitConverter.ToInt32(data, 0), size = BitConverter.ToUInt32(data, 4), send = send,
            loopback = IPAddress.IsLoopback(ip), protocol = id < 40 ? "TCP" : "UDP",
            remote = (ipv6 ? "[" + ip + "]" : ip.ToString()) + ":" + (data[port] * 256 + data[port + 1]) };
    }
    public CodexWindowsTraffic() { callback = OnEvent; }
    public void SetProcesses(Dictionary<int, string> wanted) { lock (gate) processes = wanted; }
    void AcquireOwnership() {
        if (Interlocked.CompareExchange(ref processOwner, 1, 0) != 0)
            throw new InvalidOperationException("A Windows traffic monitor is already running in this process.");
        ownsProcess = true;
        owner = new Mutex(false, @"Global\CodexDynamicTheme-Network");
        try { ownsMutex = owner.WaitOne(0); }
        catch (AbandonedMutexException) { ownsMutex = true; }
        if (!ownsMutex) throw new InvalidOperationException("The Windows traffic monitor is already running in another process.");
    }
    public void Start() {
      if (ownsProcess) throw new InvalidOperationException("The Windows traffic monitor has already been started.");
      try {
        AcquireOwnership();
        if (IntPtr.Size != 8 || Marshal.SizeOf<LogFile>() != 448 || Marshal.SizeOf<Record>() != 112)
            throw new PlatformNotSupportedException("Expected the Windows x64 ETW ABI.");
        var props = new Properties();
        int size = Marshal.SizeOf<Properties>();
        props.Wnode.BufferSize = (uint)(size + (name.Length + 1) * 2);
        props.Wnode.Flags = 0x20000; props.Wnode.ClientContext = 1;
        props.BufferSize = 64; props.MinimumBuffers = 4; props.MaximumBuffers = 64;
        props.LogFileMode = 0x100; props.FlushTimer = 1; props.LoggerNameOffset = (uint)size;
        properties = Marshal.AllocHGlobal((int)props.Wnode.BufferSize);
        Marshal.Copy(new byte[props.Wnode.BufferSize], 0, properties, (int)props.Wnode.BufferSize);
        Marshal.StructureToPtr(props, properties, false);
        ulong startedSession;
        uint start = StartTrace(out startedSession, name, properties);
        // Only the exclusive owner can reclaim this component's fixed ETW name.
        if (start == 183) {
            Check(ControlTrace(0, name, properties, 1), "Stop orphaned network trace");
            recoveredOrphan = true;
            Marshal.StructureToPtr(props, properties, false);
            start = StartTrace(out startedSession, name, properties);
        }
        Check(start, "StartTrace");
        session = startedSession;
            Guid provider = Provider;
            Check(EnableTraceEx2(session, ref provider, 1, 5, ulong.MaxValue, 0, 0, IntPtr.Zero), "EnableTraceEx2");
            var logfile = new LogFile { LoggerName = name, Mode = 0x10000100, EventCallback = callback };
            consumer = OpenTrace(ref logfile);
            if (consumer == ulong.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenTrace");
            reader = Task.Run(() => ProcessTrace(new[] { consumer }, 1, IntPtr.Zero, IntPtr.Zero));
      } catch (Exception error) {
        try { Dispose(); } catch (Exception cleanup) { error.Data["CleanupFailure"] = cleanup; }
        throw;
      }
    }
    void OnEvent(ref Record record) {
        try {
            if (record.Header.Provider != Provider) return;
            string process;
            if (record.DataLength < 4) return;
            int pid = Marshal.ReadInt32(record.Data);
            lock (gate) if (!processes.TryGetValue(pid, out process)) return;
            var data = new byte[record.DataLength]; Marshal.Copy(record.Data, data, 0, data.Length);
            var packet = Decode(record.Header.Id, record.Header.Version, data);
            if (packet == null) return;
            string key = pid + ":" + process + ":" + packet.protocol + ":" + packet.remote;
            lock (gate) {
                Row row;
                if (!pending.TryGetValue(key, out row)) {
                    row = new Row { pid = pid, process = process, protocol = packet.protocol,
                        remote = packet.remote, loopback = packet.loopback }; pending.Add(key, row);
                }
                if (packet.send) { row.up += packet.size; if (packet.loopback) localUp += packet.size; else up += packet.size; }
                else { row.down += packet.size; if (packet.loopback) localDown += packet.size; else down += packet.size; }
                row.events++; events++;
            }
        } catch (Exception error) { lock (gate) if (failure == null) failure = error; }
    }
    public Snapshot Read() {
        lock (gate) {
            if (failure != null) throw new InvalidOperationException("ETW decoding failed.", failure);
            if (reader != null && reader.IsCompleted) {
                Check(reader.GetAwaiter().GetResult(), "ProcessTrace");
                throw new InvalidOperationException("The ETW consumer stopped unexpectedly.");
            }
            Check(ControlTrace(session, name, properties, 0), "QueryTrace");
            var props = Marshal.PtrToStructure<Properties>(properties);
            var result = new Snapshot { session = run, traceSession = name, recoveredOrphan = recoveredOrphan, up = up, down = down, localUp = localUp, localDown = localDown,
                events = events, eventsLost = props.EventsLost, buffersLost = props.RealTimeBuffersLost,
                rows = new List<Row>(pending.Values).ToArray() };
            pending.Clear(); return result;
        }
    }
    public void Dispose() {
      try {
        uint stop = 0, close = 0;
        if (session != 0) { stop = ControlTrace(session, name, properties, 1); session = 0; }
        if (consumer != ulong.MaxValue) { close = CloseTrace(consumer); consumer = ulong.MaxValue; }
        if (reader != null) { uint result = reader.GetAwaiter().GetResult(); if (result != 0 && result != 1223) Check(result, "ProcessTrace cleanup"); reader = null; }
        if (properties != IntPtr.Zero) { Marshal.FreeHGlobal(properties); properties = IntPtr.Zero; }
        Check(stop, "StopTrace"); if (close != 0 && close != 7007) Check(close, "CloseTrace");
        GC.KeepAlive(callback);
      } finally {
        if (ownsMutex) { owner.ReleaseMutex(); ownsMutex = false; }
        if (owner != null) { owner.Dispose(); owner = null; }
        if (ownsProcess) { Interlocked.Exchange(ref processOwner, 0); ownsProcess = false; }
      }
    }
    static void Check(uint code, string operation) { if (code != 0) throw new Win32Exception((int)code, operation); }
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate void EventCallback(ref Record record);
    [StructLayout(LayoutKind.Sequential)] struct Wnode { public uint BufferSize, ProviderId; public ulong History, Timestamp; public Guid Guid; public uint ClientContext, Flags; }
    [StructLayout(LayoutKind.Sequential)] struct Properties {
        public Wnode Wnode; public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags;
        public int AgeLimit; public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost;
        public IntPtr LoggerThreadId; public uint LogFileNameOffset, LoggerNameOffset;
    }
    [StructLayout(LayoutKind.Sequential)] struct Header {
        public ushort Size, Type, Flags, Property; public uint ThreadId, ProcessId; public long Timestamp; public Guid Provider;
        public ushort Id; public byte Version, Channel, Level, Opcode; public ushort Task; public ulong Keyword;
        public uint KernelTime, UserTime; public Guid ActivityId;
    }
    [StructLayout(LayoutKind.Sequential)] struct Record {
        public Header Header; public uint BufferContext; public ushort ExtendedCount, DataLength; public IntPtr Extended, Data, Context;
    }
    [StructLayout(LayoutKind.Sequential, Size = 88)] struct LegacyEvent { }
    [StructLayout(LayoutKind.Sequential, Size = 280)] struct LogHeader { }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct LogFile {
        [MarshalAs(UnmanagedType.LPWStr)] public string FileName;
        [MarshalAs(UnmanagedType.LPWStr)] public string LoggerName;
        public long CurrentTime; public uint BuffersRead, Mode; public LegacyEvent CurrentEvent; public LogHeader Header;
        public IntPtr BufferCallback; public uint BufferSize, Filled, EventsLost; public EventCallback EventCallback;
        public uint IsKernelTrace; public IntPtr Context;
    }
    [DllImport("advapi32.dll", EntryPoint = "StartTraceW", CharSet = CharSet.Unicode)] static extern uint StartTrace(out ulong handle, string name, IntPtr properties);
    [DllImport("advapi32.dll")] static extern uint EnableTraceEx2(ulong handle, ref Guid provider, uint control, byte level, ulong any, ulong all, uint timeout, IntPtr parameters);
    [DllImport("advapi32.dll", EntryPoint = "OpenTraceW", CharSet = CharSet.Unicode, SetLastError = true)] static extern ulong OpenTrace(ref LogFile file);
    [DllImport("advapi32.dll")] static extern uint ProcessTrace(ulong[] handles, uint count, IntPtr start, IntPtr end);
    [DllImport("advapi32.dll", EntryPoint = "ControlTraceW", CharSet = CharSet.Unicode)] static extern uint ControlTrace(ulong handle, string name, IntPtr properties, uint control);
    [DllImport("advapi32.dll")] static extern uint CloseTrace(ulong handle);
}
