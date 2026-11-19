namespace CodexRestart {
  using System;
  using System.Collections.Generic;
  using System.Diagnostics;
  using System.Runtime.InteropServices;
  using System.Threading.Tasks;

  public static class GuardTests {
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int Register(IntPtr command,uint flags);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int Swap();
    sealed class Fixture : IDisposable {
      readonly Register original;
      internal readonly Register call;
      internal readonly IntPtr process,data;
      internal readonly List<string> received=new List<string>();
      internal uint flags;
      internal int result;
      internal Fixture(int port) {
        process=Native.OpenProcess(0x438,false,(uint)Process.GetCurrentProcess().Id); Native.Check(process!=IntPtr.Zero);
        data=Native.VirtualAllocEx(process,IntPtr.Zero,(UIntPtr)(Native.Page*2),0x3000,4); Native.Check(data!=IntPtr.Zero);
        original=(command,value)=>{ lock(received) { received.Add(Marshal.PtrToStringUni(command)); flags=value; } return result; };
        IntPtr code=new IntPtr(data.ToInt64()+Native.Page);
        byte[] header=Native.Header(data,Marshal.GetFunctionPointerForDelegate(original),IntPtr.Zero,IntPtr.Zero,port);
        Marshal.Copy(header,0,data,header.Length);
        byte[] wrapper=Native.Wrapper(data); Marshal.Copy(wrapper,0,code,wrapper.Length);
        uint previous; Native.Check(Native.VirtualProtectEx(process,code,(UIntPtr)Native.Page,0x20,out previous));
        Native.Check(Native.FlushInstructionCache(process,code,(UIntPtr)wrapper.Length));
        call=Marshal.GetDelegateForFunctionPointer<Register>(code);
      }
      internal int Invoke(string command,uint value) {
        IntPtr text=command==null?IntPtr.Zero:Marshal.StringToHGlobalUni(command);
        try { return call(text,value); } finally { if(text!=IntPtr.Zero) Marshal.FreeHGlobal(text); }
      }
      internal ulong Count { get { return unchecked((ulong)Marshal.ReadInt64(data,40)); } }
      internal int Exchange(long expected,long replacement) {
        IntPtr slot=new IntPtr(data.ToInt64()+96),code=new IntPtr(data.ToInt64()+Native.Page),entry=new IntPtr(code.ToInt64()+((Native.Wrapper(data).Length+15)&~15));
        byte[] swap=Native.Exchange(slot,new IntPtr(expected),new IntPtr(replacement));
        uint previous; Native.Check(Native.VirtualProtectEx(process,code,(UIntPtr)Native.Page,4,out previous));
        Marshal.Copy(swap,0,entry,swap.Length);
        uint ignored; Native.Check(Native.VirtualProtectEx(process,code,(UIntPtr)Native.Page,previous,out ignored));
        Native.Check(Native.FlushInstructionCache(process,entry,(UIntPtr)swap.Length));
        return Marshal.GetDelegateForFunctionPointer<Swap>(entry)();
      }
      public void Dispose() { GC.KeepAlive(original); Native.Check(Native.VirtualFreeEx(process,data,UIntPtr.Zero,0x8000)); Native.CloseHandle(process); }
    }
    static void Equal<T>(T expected,T actual,string label) { if(!EqualityComparer<T>.Default.Equals(expected,actual)) throw new InvalidOperationException(label+": expected '"+expected+"', got '"+actual+"'."); }
    public static string Run() {
      const int port=51940; string suffix=Native.Suffix(port);
      using(var f=new Fixture(port)) {
        Marshal.WriteInt64(f.data,96,0x1111);
        Equal(0,f.Exchange(0x1111,0x2222),"Atomic import publication");
        Equal((long)0x2222,Marshal.ReadInt64(f.data,96),"Published pointer readback");
        Equal(unchecked((int)0x80004005),f.Exchange(0x1111,0x3333),"Changed import owner is rejected");
        Equal((long)0x2222,Marshal.ReadInt64(f.data,96),"Foreign pointer is not overwritten");
      }
      using(var f=new Fixture(port)) {
        Equal(0,f.Invoke("",0),"Store registration result"); Equal(suffix,f.received[0],"Empty Store argument is augmented"); Equal((uint)0,f.flags,"Store flags");
        Equal(0,f.Invoke("codex://launch",3),"MSIX registration result"); Equal("codex://launch "+suffix,f.received[1],"MSIX URI retained"); Equal((uint)3,f.flags,"MSIX flags");
        string unicode="--official-mode \"保留这些值 🦦\"";
        f.Invoke(unicode,0xfedcba98); Equal(unicode+" "+suffix,f.received[2],"Unicode/quotes"); Equal((uint)0xfedcba98,f.flags,"All flag bits");
        f.Invoke(suffix,1); Equal(suffix,f.received[3],"Idempotent CDP-only arguments");
        f.Invoke("codex://launch "+suffix,2); Equal("codex://launch "+suffix,f.received[4],"Idempotent URI/CDP arguments");
        f.Invoke(null,8); Equal(suffix,f.received[5],"Null argument");
        f.Invoke("prefix"+suffix,0); Equal("prefix"+suffix+" "+suffix,f.received[6],"Suffix must start at an argument boundary");
        f.result=unchecked((int)0x80004005); Equal(f.result,f.Invoke("codex://launch",11),"Native HRESULT unchanged");
        Equal(f.result,Marshal.ReadInt32(f.data,52),"Observed native error");
        int before=f.received.Count;
        Equal(unchecked((int)0x80070057),f.Invoke(new string('x',1023),0),"RESTART_MAX_CMD_LINE boundary");
        Equal(before,f.received.Count,"Oversized merged command never calls original");
        Equal((ulong)9,f.Count,"Call count includes native failure and length failure");
      }
      using(var f=new Fixture(port)) {
        Parallel.For(0,24,index=>{ string input="--parallel="+index; Equal(0,f.Invoke(input,(uint)index),"Concurrent registration"); });
        Equal((ulong)24,f.Count,"Atomic call count"); Equal(24,f.received.Count,"Per-call stack buffers");
        foreach(string value in f.received) if(!value.StartsWith("--parallel=") || !value.EndsWith(" "+suffix)) throw new InvalidOperationException("Concurrent argument buffers overlapped.");
      }
      return "Native x64 restart guard verified: Store/MSIX arguments, Unicode, flags, idempotence, HRESULT, protocol size and concurrent callers. No app or updater was invoked.";
    }
  }
}
