using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

namespace WinHelm.Installer {
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    public class ShellLink {}

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
    public interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, uint fFlags);
        void GetIDList(out IntPtr ppidl);
        void SetIDList(IntPtr pidl);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
        void GetHotkey(out short pwHotkey);
        void SetHotkey(short wHotkey);
        void GetShowCmd(out int piShowCmd);
        void SetShowCmd(int iShowCmd);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, uint dwReserved);
        void Resolve(IntPtr hwnd, uint fFlags);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    public interface IPropertyStore {
        uint GetCount();
        void GetAt(uint iProp, out PropertyKey pkey);
        void GetValue([In] ref PropertyKey key, out PropVariant pv);
        void SetValue([In] ref PropertyKey key, [In] ref PropVariant pv);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PropertyKey {
        public Guid fmtid;
        public uint pid;
        public PropertyKey(Guid guid, uint id) {
            fmtid = guid;
            pid = id;
        }
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    public struct PropVariant {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr ptr;
    }

    public class ShortcutDetails {
        public string TargetPath { get; set; }
        public string Arguments { get; set; }
        public string WorkingDirectory { get; set; }
        public string AppUserModelId { get; set; }
        public bool Exists { get; set; }
    }

    public static class ShortcutHelper {
        [DllImport("ole32.dll")]
        public static extern int PropVariantClear(ref PropVariant pvar);

        private static readonly PropertyKey AppUserModelIDKey = new PropertyKey(new Guid("9F4C2855-9F79-48A4-BA85-86E35D08DFF0"), 5);

        public static void CreateOrUpdateShortcut(
            string shortcutPath,
            string targetPath,
            string arguments,
            string workingDirectory,
            string appUserModelId,
            string description = "WinHelm Process Controller"
        ) {
            if (string.IsNullOrEmpty(shortcutPath)) throw new ArgumentNullException("shortcutPath");
            if (string.IsNullOrEmpty(targetPath)) throw new ArgumentNullException("targetPath");

            string dir = Path.GetDirectoryName(shortcutPath);
            if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) {
                Directory.CreateDirectory(dir);
            }

            var link = (IShellLinkW)new ShellLink();
            link.SetPath(targetPath);
            if (!string.IsNullOrEmpty(arguments)) link.SetArguments(arguments);
            if (!string.IsNullOrEmpty(workingDirectory)) link.SetWorkingDirectory(workingDirectory);
            if (!string.IsNullOrEmpty(description)) link.SetDescription(description);

            if (!string.IsNullOrEmpty(appUserModelId)) {
                var store = (IPropertyStore)link;
                var pv = new PropVariant();
                pv.vt = 31; // VT_LPWSTR
                pv.ptr = Marshal.StringToCoTaskMemUni(appUserModelId);
                try {
                    var key = AppUserModelIDKey;
                    store.SetValue(ref key, ref pv);
                    store.Commit();
                } finally {
                    PropVariantClear(ref pv);
                }
            }

            var persistFile = (IPersistFile)link;
            persistFile.Save(shortcutPath, true);
        }

        public static ShortcutDetails GetShortcutDetails(string shortcutPath) {
            var details = new ShortcutDetails();
            if (string.IsNullOrEmpty(shortcutPath) || !File.Exists(shortcutPath)) {
                details.Exists = false;
                return details;
            }

            details.Exists = true;
            try {
                var link = (IShellLinkW)new ShellLink();
                var persistFile = (IPersistFile)link;
                persistFile.Load(shortcutPath, 0);

                var sbPath = new StringBuilder(1024);
                link.GetPath(sbPath, sbPath.Capacity, IntPtr.Zero, 0);
                details.TargetPath = sbPath.ToString();

                var sbArgs = new StringBuilder(4096);
                link.GetArguments(sbArgs, sbArgs.Capacity);
                details.Arguments = sbArgs.ToString();

                var sbDir = new StringBuilder(1024);
                link.GetWorkingDirectory(sbDir, sbDir.Capacity);
                details.WorkingDirectory = sbDir.ToString();

                var store = (IPropertyStore)link;
                var key = AppUserModelIDKey;
                PropVariant pv;
                store.GetValue(ref key, out pv);
                if (pv.vt == 31 && pv.ptr != IntPtr.Zero) {
                    details.AppUserModelId = Marshal.PtrToStringUni(pv.ptr);
                    PropVariantClear(ref pv);
                }
            } catch {
                // If corrupted or unreadable
            }

            return details;
        }
    }
}
