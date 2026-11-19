using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CodexRestart {
  public sealed class PackageIdentity {
    public string fullName;
    public string familyName;
    public string installLocation;
  }
  public sealed class GuardStatus {
    public bool hookInstalled;
    public bool hookVerified;
    public int hookVersion;
    public string hookAddress;
    public ulong calls;
    public uint lastFlags;
    public int lastResult;
  }

  public static class Native {
    internal const int SuffixOffset = 128;
    internal const ulong Magic = 0x3230545352504443; // CDPRST02
    internal static readonly int Page = Environment.SystemPageSize;
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackageFamilyName(IntPtr process, ref uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetPackagePathByFullName(string fullName, ref uint length, StringBuilder value);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern int GetApplicationRestartSettings(IntPtr process, StringBuilder command, ref uint length, out uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] internal static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll", CharSet=CharSet.Ansi, SetLastError=true)] internal static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, uint allocation, uint protection);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool VirtualFreeEx(IntPtr process, IntPtr address, UIntPtr size, uint type);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] data, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool VirtualProtectEx(IntPtr process, IntPtr address, UIntPtr size, uint protection, out uint previous);
    [DllImport("kernel32.dll", SetLastError=true)] internal static extern bool FlushInstructionCache(IntPtr process, IntPtr address, UIntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateRemoteThread(IntPtr process, IntPtr attributes, UIntPtr stack, IntPtr entry, IntPtr argument, uint flags, out uint id);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeThread(IntPtr thread, out uint result);
    internal static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    public static PackageIdentity Package(uint pid) {
      IntPtr process=OpenProcess(0x1000,false,pid); Check(process!=IntPtr.Zero);
      try {
        uint size=0; int result=GetPackageFullName(process,ref size,null); if(result!=122) throw new Win32Exception(result);
        var full=new StringBuilder((int)size); result=GetPackageFullName(process,ref size,full); if(result!=0) throw new Win32Exception(result);
        size=0; result=GetPackageFamilyName(process,ref size,null); if(result!=122) throw new Win32Exception(result);
        var family=new StringBuilder((int)size); result=GetPackageFamilyName(process,ref size,family); if(result!=0) throw new Win32Exception(result);
        size=0; result=GetPackagePathByFullName(full.ToString(),ref size,null); if(result!=122) throw new Win32Exception(result);
        var location=new StringBuilder((int)size); result=GetPackagePathByFullName(full.ToString(),ref size,location); if(result!=0) throw new Win32Exception(result);
        return new PackageIdentity { fullName=full.ToString(),familyName=family.ToString(),installLocation=location.ToString() };
      } finally { CloseHandle(process); }
    }
    static IntPtr At(IntPtr address, long offset) { return new IntPtr(address.ToInt64()+offset); }
    internal static byte[] ReadBytes(IntPtr process, IntPtr address, int size) {
      var data=new byte[size]; UIntPtr read;
      Check(ReadProcessMemory(process,address,data,(UIntPtr)size,out read));
      if(read.ToUInt64()!=(ulong)size) throw new InvalidOperationException("Incomplete native restart read.");
      return data;
    }
    internal static void WriteBytes(IntPtr process, IntPtr address, byte[] data) {
      UIntPtr written; Check(WriteProcessMemory(process,address,data,(UIntPtr)data.Length,out written));
      if(written.ToUInt64()!=(ulong)data.Length) throw new InvalidOperationException("Incomplete native restart write.");
    }
    static IntPtr Pointer(IntPtr process, IntPtr address) { return new IntPtr(BitConverter.ToInt64(ReadBytes(process,address,8),0)); }
    internal static string Suffix(int port) {
      if(port<1024 || port>65535) throw new ArgumentOutOfRangeException("port");
      return "--remote-debugging-address=127.0.0.1 --remote-debugging-port="+port+" --remote-allow-origins=http://127.0.0.1:"+port;
    }
    public static string Read(uint pid, out uint flags) {
      IntPtr process=OpenProcess(0x410,false,pid); Check(process!=IntPtr.Zero);
      try { uint size=1024; var text=new StringBuilder(1024); Marshal.ThrowExceptionForHR(GetApplicationRestartSettings(process,text,ref size,out flags)); return text.ToString(); }
      finally { CloseHandle(process); }
    }
    static IntPtr OriginalFunction(uint pid) {
      IntPtr function=GetProcAddress(GetModuleHandle("kernel32.dll"),"RegisterApplicationRestart"); Check(function!=IntPtr.Zero);
      foreach(ProcessModule local in Process.GetCurrentProcess().Modules) {
        long offset=function.ToInt64()-local.BaseAddress.ToInt64();
        if(offset<0 || offset>=local.ModuleMemorySize) continue;
        foreach(ProcessModule remote in Process.GetProcessById((int)pid).Modules)
          if(String.Equals(local.FileName,remote.FileName,StringComparison.OrdinalIgnoreCase)) return At(remote.BaseAddress,offset);
        throw new InvalidOperationException("The Windows restart API module is not loaded in the app.");
      }
      throw new InvalidOperationException("The Windows restart API module was not found.");
    }
    static string ImportName(IntPtr process, IntPtr module, uint rva, int imageSize) {
      var bytes=new List<byte>();
      while(rva<imageSize) {
        byte[] part=ReadBytes(process,At(module,rva),Math.Min(128,imageSize-(int)rva));
        foreach(byte b in part) { if(b==0) return Encoding.ASCII.GetString(bytes.ToArray()); if(b>127) throw new InvalidOperationException("Non-ASCII PE import name."); bytes.Add(b); }
        rva+=(uint)part.Length;
      }
      throw new InvalidOperationException("Unterminated PE import name.");
    }
    static IntPtr FindSlot(IntPtr process, ProcessModule module) {
      byte[] dos=ReadBytes(process,module.BaseAddress,64);
      if(BitConverter.ToUInt16(dos,0)!=0x5a4d) throw new InvalidOperationException("The updater image is not PE.");
      byte[] pe=ReadBytes(process,At(module.BaseAddress,BitConverter.ToUInt32(dos,60)),144);
      if(BitConverter.ToUInt32(pe,0)!=0x4550 || BitConverter.ToUInt16(pe,4)!=0x8664 || BitConverter.ToUInt16(pe,24)!=0x20b)
        throw new InvalidOperationException("The updater image is not Windows x64 PE32+.");
      return FindImportSlot(process,module,At(module.BaseAddress,BitConverter.ToUInt32(dos,60)));
    }
    static IntPtr FindImportSlot(IntPtr process, ProcessModule module, IntPtr pe) {
      uint directory=BitConverter.ToUInt32(ReadBytes(process,At(pe,24+120),8),0);
      for(uint offset=directory;offset+20<=module.ModuleMemorySize;offset+=20) {
        byte[] descriptor=ReadBytes(process,At(module.BaseAddress,offset),20);
        uint name=BitConverter.ToUInt32(descriptor,12); if(name==0) break;
        if(!String.Equals(ImportName(process,module.BaseAddress,name,module.ModuleMemorySize),"kernel32.dll",StringComparison.OrdinalIgnoreCase)) continue;
        uint names=BitConverter.ToUInt32(descriptor,0),slots=BitConverter.ToUInt32(descriptor,16);
        if(names==0) throw new InvalidOperationException("The updater import names are unavailable.");
        for(uint i=0;names+8*i+8<=module.ModuleMemorySize;i++) {
          ulong thunk=BitConverter.ToUInt64(ReadBytes(process,At(module.BaseAddress,names+8*i),8),0);
          if(thunk==0) break;
          if((thunk&0x8000000000000000)!=0) continue;
          if(ImportName(process,module.BaseAddress,checked((uint)thunk+2),module.ModuleMemorySize)=="RegisterApplicationRestart") {
            IntPtr slot=At(module.BaseAddress,slots+8*i);
            if((slot.ToInt64()&7)!=0) throw new InvalidOperationException("The restart import slot is not pointer-aligned.");
            return slot;
          }
        }
      }
      throw new InvalidOperationException("The native updater no longer imports RegisterApplicationRestart.");
    }
    static ProcessModule Updater(uint pid, string expectedPath) {
      foreach(ProcessModule module in Process.GetProcessById((int)pid).Modules)
        if(String.Equals(module.FileName,expectedPath,StringComparison.OrdinalIgnoreCase)) return module;
      throw new InvalidOperationException("The native Windows updater module is not loaded.");
    }

    // Only labels/rel32 branches are assembled here. No third-party assembler or
    // target-version offsets are used. All external addresses come from PE/API reads.
    sealed class Code {
      readonly List<byte> bytes=new List<byte>();
      readonly Dictionary<string,int> labels=new Dictionary<string,int>();
      readonly List<KeyValuePair<int,string>> branches=new List<KeyValuePair<int,string>>();
      public void Emit(params byte[] value) { bytes.AddRange(value); }
      public void U64(long value) { Emit(BitConverter.GetBytes(value)); }
      public void Label(string name) { labels.Add(name,bytes.Count); }
      public void Jump(string name, params byte[] opcode) { Emit(opcode); branches.Add(new KeyValuePair<int,string>(bytes.Count,name)); Emit(0,0,0,0); }
      public byte[] Finish() {
        foreach(var branch in branches) { byte[] value=BitConverter.GetBytes(labels[branch.Value]-branch.Key-4); for(int i=0;i<4;i++) bytes[branch.Key+i]=value[i]; }
        return bytes.ToArray();
      }
    }
    internal static byte[] Wrapper(IntPtr data) {
      var c=new Code();
      // Five saved nonvolatile registers align RSP for the Win64 call. 32 bytes
      // of shadow space + 1024 UTF-16 characters live on each caller's own stack.
      c.Emit(0x53,0x56,0x57,0x41,0x54,0x41,0x55,0x48,0x81,0xec,0x20,0x08,0,0);
      c.Emit(0x49,0xbc); c.U64(data.ToInt64());
      c.Emit(0x48,0x8b,0xf1,0x44,0x8b,0xea,0x48,0x8d,0x7c,0x24,0x20,0x33,0xdb,0x48,0x85,0xf6);
      c.Jump("copied",0x0f,0x84);
      c.Label("copy"); c.Emit(0x0f,0xb7,0x04,0x5e,0x66,0x85,0xc0); c.Jump("copied",0x0f,0x84);
      c.Emit(0x81,0xfb,0xff,0x03,0,0); c.Jump("overflow",0x0f,0x83);
      c.Emit(0x66,0x89,0x04,0x5f,0xff,0xc3); c.Jump("copy",0xe9);
      c.Label("copied"); c.Emit(0x41,0x89,0x5c,0x24,0x38,0x45,0x8b,0x44,0x24,0x48,0x44,0x39,0xc3); c.Jump("append",0x0f,0x82);
      c.Emit(0x41,0x89,0xd9,0x45,0x29,0xc1,0x45,0x85,0xc9); c.Jump("compare",0x0f,0x84);
      c.Emit(0x66,0x42,0x83,0x7c,0x4f,0xfe,0x20); c.Jump("compare",0x0f,0x84);
      c.Emit(0x66,0x42,0x83,0x7c,0x4f,0xfe,0x09); c.Jump("append",0x0f,0x85);
      c.Label("compare"); c.Emit(0x4d,0x8d,0x94,0x24,0x80,0,0,0,0x4e,0x8d,0x1c,0x4f,0x33,0xc9);
      c.Label("compareLoop"); c.Emit(0x44,0x39,0xc1); c.Jump("invoke",0x0f,0x83);
      c.Emit(0x66,0x41,0x8b,0x04,0x4a,0x66,0x41,0x3b,0x04,0x4b); c.Jump("append",0x0f,0x85);
      c.Emit(0xff,0xc1); c.Jump("compareLoop",0xe9);
      c.Label("append"); c.Emit(0x8b,0xc3,0x85,0xdb); c.Jump("size",0x0f,0x84);
      c.Emit(0xff,0xc0); c.Label("size"); c.Emit(0x44,0x01,0xc0,0x3d,0xff,0x03,0,0); c.Jump("overflow",0x0f,0x87);
      c.Emit(0x85,0xdb); c.Jump("suffix",0x0f,0x84);
      c.Emit(0x66,0xc7,0x04,0x5f,0x20,0,0xff,0xc3);
      c.Label("suffix"); c.Emit(0x49,0x8d,0xb4,0x24,0x80,0,0,0,0x33,0xc9);
      c.Label("suffixLoop"); c.Emit(0x66,0x8b,0x04,0x4e,0x66,0x89,0x04,0x5f,0xff,0xc1,0xff,0xc3,0x44,0x39,0xc1); c.Jump("suffixLoop",0x0f,0x82);
      c.Label("invoke"); c.Emit(0x66,0xc7,0x04,0x5f,0,0,0x41,0x89,0x5c,0x24,0x3c,0x48,0x8b,0xcf,0x41,0x8b,0xd5,0x49,0x8b,0x44,0x24,0x10,0xff,0xd0); c.Jump("result",0xe9);
      c.Label("overflow"); c.Emit(0xb8,0x57,0,0x07,0x80,0x41,0xc7,0x44,0x24,0x3c,0,0,0,0);
      c.Label("result"); c.Emit(0x45,0x89,0x6c,0x24,0x30,0x41,0x89,0x44,0x24,0x34,0xf0,0x49,0xff,0x44,0x24,0x28);
      c.Emit(0x48,0x81,0xc4,0x20,0x08,0,0,0x41,0x5d,0x41,0x5c,0x5f,0x5e,0x5b,0xc3);
      return c.Finish();
    }
    internal static byte[] Header(IntPtr data, IntPtr original, IntPtr slot, IntPtr module, int port) {
      var header=new byte[Page]; string suffix=Suffix(port); byte[] text=Encoding.Unicode.GetBytes(suffix+"\0");
      if(SuffixOffset+text.Length>Page) throw new InvalidOperationException("Restart suffix exceeds the native data page.");
      Array.Copy(BitConverter.GetBytes(Magic),0,header,0,8);
      Array.Copy(BitConverter.GetBytes(port),0,header,8,4);
      Array.Copy(BitConverter.GetBytes(Wrapper(data).Length),0,header,12,4);
      Array.Copy(BitConverter.GetBytes(original.ToInt64()),0,header,16,8);
      Array.Copy(BitConverter.GetBytes(slot.ToInt64()),0,header,24,8);
      Array.Copy(BitConverter.GetBytes(module.ToInt64()),0,header,32,8);
      Array.Copy(BitConverter.GetBytes(suffix.Length),0,header,72,4);
      Array.Copy(text,0,header,SuffixOffset,text.Length); return header;
    }
    static GuardStatus Inspect(IntPtr process, ProcessModule module, IntPtr slot, IntPtr original, int port) {
      IntPtr pointer=Pointer(process,slot);
      if(pointer==original) return new GuardStatus();
      IntPtr data=At(pointer,-Page); byte[] header=ReadBytes(process,data,80);
      if(BitConverter.ToUInt64(header,0)!=Magic || BitConverter.ToInt64(header,16)!=original.ToInt64()
        || BitConverter.ToInt64(header,24)!=slot.ToInt64() || BitConverter.ToInt64(header,32)!=module.BaseAddress.ToInt64())
        throw new InvalidOperationException("Another component owns the updater restart import; it was not overwritten.");
      byte[] expected=Wrapper(data),actual=ReadBytes(process,pointer,expected.Length);
      if(BitConverter.ToInt32(header,12)!=expected.Length) throw new InvalidOperationException("The restart guard code length changed.");
      for(int i=0;i<actual.Length;i++) if(actual[i]!=expected[i]) throw new InvalidOperationException("The restart guard code readback did not match.");
      int installedPort=BitConverter.ToInt32(header,8); byte[] suffix=Encoding.Unicode.GetBytes(Suffix(installedPort)+"\0");
      byte[] suffixRead=ReadBytes(process,At(data,SuffixOffset),suffix.Length);
      if(BitConverter.ToInt32(header,72)!=Suffix(installedPort).Length) throw new InvalidOperationException("The restart guard suffix length changed.");
      for(int i=0;i<suffix.Length;i++) if(suffix[i]!=suffixRead[i]) throw new InvalidOperationException("The restart guard arguments readback did not match.");
      return new GuardStatus { hookInstalled=true, hookVerified=installedPort==port, hookVersion=2,
        hookAddress="0x"+pointer.ToInt64().ToString("x"),calls=BitConverter.ToUInt64(header,40),lastFlags=BitConverter.ToUInt32(header,48),lastResult=BitConverter.ToInt32(header,52) };
    }
    public static GuardStatus InspectGuard(uint pid, string updaterPath, int port) {
      IntPtr process=OpenProcess(0x410,false,pid); Check(process!=IntPtr.Zero);
      try { ProcessModule module=Updater(pid,updaterPath); return Inspect(process,module,FindSlot(process,module),OriginalFunction(pid),port); }
      finally { CloseHandle(process); }
    }
    static uint Run(IntPtr process, IntPtr entry) {
      uint id; IntPtr thread=CreateRemoteThread(process,IntPtr.Zero,UIntPtr.Zero,entry,IntPtr.Zero,0,out id); Check(thread!=IntPtr.Zero);
      try {
        // The target runs straight-line registration/compare-exchange code, not
        // an update operation. Do not free executable memory while it is in use.
        if(WaitForSingleObject(thread,0xffffffff)!=0) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint result; Check(GetExitCodeThread(thread,out result)); return result;
      } finally { CloseHandle(thread); }
    }
    internal static byte[] Exchange(IntPtr slot, IntPtr before, IntPtr replacement) {
      var code=new List<byte>(new byte[] {0x48,0xb9}); code.AddRange(BitConverter.GetBytes(slot.ToInt64()));
      code.AddRange(new byte[]{0x48,0xb8}); code.AddRange(BitConverter.GetBytes(before.ToInt64()));
      code.AddRange(new byte[]{0x48,0xba}); code.AddRange(BitConverter.GetBytes(replacement.ToInt64()));
      code.AddRange(new byte[]{0xf0,0x48,0x0f,0xb1,0x11,0x75,0x03,0x31,0xc0,0xc3,0xb8,0x05,0x40,0,0x80,0xc3});
      return code.ToArray();
    }
    public static GuardStatus InstallGuard(uint pid, string updaterPath, int port) {
      IntPtr process=OpenProcess(0x43a,false,pid); Check(process!=IntPtr.Zero);
      IntPtr data=IntPtr.Zero; bool published=false,retain=false;
      try {
        ProcessModule module=Updater(pid,updaterPath); IntPtr slot=FindSlot(process,module),original=OriginalFunction(pid),before=Pointer(process,slot);
        GuardStatus status=Inspect(process,module,slot,original,port); if(status.hookVerified) return status;
        data=VirtualAllocEx(process,IntPtr.Zero,(UIntPtr)(2*Page),0x3000,4); Check(data!=IntPtr.Zero);
        IntPtr code=At(data,Page); byte[] wrapper=Wrapper(data);
        byte[] exchange=Exchange(slot,before,code);
        int exchangeOffset=(wrapper.Length+15)&~15;
        if(exchangeOffset+exchange.Length>Page) throw new InvalidOperationException("Restart guard exceeds its native code page.");
        WriteBytes(process,data,Header(data,original,slot,module.BaseAddress,port)); WriteBytes(process,code,wrapper);
        WriteBytes(process,At(code,exchangeOffset),exchange);
        uint previous; Check(VirtualProtectEx(process,code,(UIntPtr)Page,0x20,out previous)); Check(FlushInstructionCache(process,code,(UIntPtr)Page));
        uint slotProtection; Check(VirtualProtectEx(process,slot,(UIntPtr)8,4,out slotProtection));
        Exception primary=null;
        try {
          retain=true;
          uint result=Run(process,At(code,exchangeOffset)); published=Pointer(process,slot)==code; retain=result==0 || published;
          Marshal.ThrowExceptionForHR(unchecked((int)result));
          if(!published) throw new InvalidOperationException("The updater restart import readback did not match.");
        } catch(Exception error) { primary=error; throw; }
        finally {
          uint ignored;
          if(!VirtualProtectEx(process,slot,(UIntPtr)8,slotProtection,out ignored)) {
            var failure=new Win32Exception(Marshal.GetLastWin32Error());
            if(primary!=null) primary.Data["RestoreImportProtectionError"]=failure; else throw failure;
          }
        }
        // Replacing our own older port leaves its tiny allocation alive until
        // process exit: another thread could still be returning through it.
        return Inspect(process,module,slot,original,port);
      } finally {
        if(data!=IntPtr.Zero && !retain) VirtualFreeEx(process,data,UIntPtr.Zero,0x8000);
        CloseHandle(process);
      }
    }
    public static void RegisterThroughUpdater(uint pid, string updaterPath, string command, uint flags) {
      if(command==null) command="";
      if(command.Length>=1024) throw new ArgumentException("Windows restart arguments exceed RESTART_MAX_CMD_LINE.");
      IntPtr process=OpenProcess(0x43a,false,pid); Check(process!=IntPtr.Zero);
      IntPtr memory=IntPtr.Zero; bool complete=false,attempted=false;
      try {
        ProcessModule module=Updater(pid,updaterPath); IntPtr function=Pointer(process,FindSlot(process,module));
        byte[] text=Encoding.Unicode.GetBytes(command+"\0");
        memory=VirtualAllocEx(process,IntPtr.Zero,(UIntPtr)(Page*2),0x3000,4); Check(memory!=IntPtr.Zero);
        var code=new List<byte>(new byte[]{0x48,0x83,0xec,0x28,0x48,0xb9}); code.AddRange(BitConverter.GetBytes(memory.ToInt64()+Page));
        code.Add(0xba); code.AddRange(BitConverter.GetBytes(flags)); code.AddRange(new byte[]{0x48,0xb8});
        code.AddRange(BitConverter.GetBytes(function.ToInt64())); code.AddRange(new byte[]{0xff,0xd0,0x48,0x83,0xc4,0x28,0xc3});
        WriteBytes(process,memory,code.ToArray()); WriteBytes(process,At(memory,Page),text);
        uint previous; Check(VirtualProtectEx(process,memory,(UIntPtr)Page,0x20,out previous)); Check(FlushInstructionCache(process,memory,(UIntPtr)Page));
        attempted=true; uint result=Run(process,memory); complete=true; Marshal.ThrowExceptionForHR(unchecked((int)result));
      } finally {
        if(memory!=IntPtr.Zero && (complete || !attempted)) VirtualFreeEx(process,memory,UIntPtr.Zero,0x8000);
        CloseHandle(process);
      }
    }
  }
}
