// Opens Charts: starts the local server hidden, shows the window, and shuts everything down on close.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Charts")]
[assembly: AssemblyProduct("Charts")]
[assembly: AssemblyVersion("1.4.0.0")]

static class Launcher
{
    const string Url = "http://localhost:5180";
    static readonly string Root = AppDomain.CurrentDomain.BaseDirectory;

    [STAThread]
    static void Main(string[] args)
    {
        try { if (Array.IndexOf(args, "--uninstall") >= 0) Uninstall(Array.IndexOf(args, "--quiet") >= 0); else Run(); }
        catch (Exception e) { Fail("Could not open Charts.\n\n" + e.Message); }
    }

    static void Run()
    {
        if (!File.Exists(Path.Combine(Root, "server", "index.js")))
        {
            Fail("charts.exe must stay in its folder, next to the server and public folders.\n\nTo have an icon elsewhere, create a shortcut instead of moving the file.");
            return;
        }

        Process server = null;
        StringBuilder log = new StringBuilder();
        if (!Ping())
        {
            if (PortBusy()) { Fail("Port 5180 is being used by another program."); return; }
            string node = FindNode();
            if (node == null) { Fail("Node.js was not found. Install version 24 or newer from nodejs.org and try again."); return; }
            server = StartServer(node, log);
            DateTime limit = DateTime.Now.AddSeconds(25);
            while (!Ping())
            {
                if (server.HasExited || DateTime.Now > limit)
                {
                    if (!server.HasExited) server.Kill();
                    string text; lock (log) text = log.ToString();
                    Fail("The local server did not start.\n\n" + (text.Length > 900 ? text.Substring(text.Length - 900) : text));
                    return;
                }
                Thread.Sleep(150);
            }
        }

        string browser = FindBrowser();
        if (browser != null)
        {
            string profile = Path.Combine(Root, "data", "window");
            ProcessStartInfo info = new ProcessStartInfo(browser,
                "--app=" + Url + " --user-data-dir=\"" + profile + "\" --no-first-run --no-default-browser-check --disable-background-mode --disable-features=Translate --lang=en-US --start-maximized");
            info.UseShellExecute = false;
            using (Process window = Process.Start(info)) window.WaitForExit();
            if (server != null) Thread.Sleep(800); // let pending saves finish
        }
        else
        {
            Process.Start(Url);
            if (server != null) MessageBox.Show("Charts is open in your browser.\n\nClick OK when you want to quit.", "Charts");
        }

        if (server != null && !server.HasExited) server.Kill();
    }

    // Removes only what setup created. The data folder (watchlist, history, drawings) stays.
    static void Uninstall(bool quiet)
    {
        string info = Path.Combine(Root, "install.txt");
        if (!File.Exists(info)) { if (!quiet) Fail("This copy was not installed by setup.exe. To remove it, delete its folder."); return; }
        if (Ping() && !quiet) { Fail("Close Charts before uninstalling."); return; }
        if (!quiet && MessageBox.Show("Uninstall Charts?\n\nYour data will be kept in:\n" + Path.Combine(Root, "data"), "Charts", MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        string[] lines = File.ReadAllLines(info, Encoding.UTF8);
        for (int i = 1; i < lines.Length; i++)
            if (lines[i].EndsWith(".lnk", StringComparison.OrdinalIgnoreCase) && File.Exists(lines[i])) File.Delete(lines[i]);
        if (lines[0].EndsWith("Charts") || lines[0].EndsWith("ChartsSetupTest")) Registry.CurrentUser.DeleteSubKeyTree(lines[0], false);
        File.Delete(info);
        foreach (string d in new[] { "server", "public", "runtime" })
            if (Directory.Exists(Path.Combine(Root, d))) Directory.Delete(Path.Combine(Root, d), true);
        foreach (string n in new[] { "package.json", "README.txt", "LICENSE.txt" }) File.Delete(Path.Combine(Root, n));
        // The exe can only be deleted after it closes; the folder is removed only if empty.
        ProcessStartInfo cmd = new ProcessStartInfo("cmd.exe", "/c ping -n 3 127.0.0.1 >nul & del \"" + Application.ExecutablePath + "\" & rmdir \"" + Root.TrimEnd('\\') + "\"");
        cmd.WorkingDirectory = Path.GetTempPath();
        cmd.UseShellExecute = false;
        cmd.CreateNoWindow = true;
        Process.Start(cmd);
        if (!quiet) MessageBox.Show("Charts was uninstalled.", "Charts");
    }

    static Process StartServer(string node, StringBuilder log)
    {
        ProcessStartInfo info = new ProcessStartInfo(node, "server/index.js");
        info.WorkingDirectory = Root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.StandardOutputEncoding = Encoding.UTF8;
        info.StandardErrorEncoding = Encoding.UTF8;
        info.EnvironmentVariables.Remove("PORT");
        info.EnvironmentVariables.Remove("CHARTS_DB");
        Process p = new Process();
        p.StartInfo = info;
        DataReceivedEventHandler add = delegate(object s, DataReceivedEventArgs e)
        {
            if (e.Data == null) return;
            lock (log) { log.AppendLine(e.Data); if (log.Length > 20000) log.Remove(0, log.Length - 10000); }
        };
        p.OutputDataReceived += add;
        p.ErrorDataReceived += add;
        p.Start();
        Job.Attach(p); // if this program dies, the server dies with it
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        return p;
    }

    static bool Ping()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:5180/api/ping");
            req.Proxy = null;
            req.Timeout = 1500;
            using (WebResponse res = req.GetResponse())
            using (StreamReader r = new StreamReader(res.GetResponseStream()))
                return r.ReadToEnd().Contains("charts-app");
        }
        catch (WebException) { return false; }
    }

    static bool PortBusy()
    {
        using (TcpClient c = new TcpClient())
        {
            try { c.Connect("127.0.0.1", 5180); return true; }
            catch (SocketException) { return false; }
        }
    }

    // Looks for a bundled Node first (runtime\node.exe), then the installed one.
    static string FindNode()
    {
        string local = Path.Combine(Root, "runtime", "node.exe");
        if (File.Exists(local)) return local;
        foreach (string dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
        {
            try
            {
                string d = dir.Trim().Trim('"');
                if (d.Length > 0 && Path.IsPathRooted(d) && File.Exists(Path.Combine(d, "node.exe"))) return Path.Combine(d, "node.exe");
            }
            catch (ArgumentException) { }
        }
        return First(@"nodejs\node.exe");
    }

    static string FindBrowser()
    {
        return First(@"Microsoft\Edge\Application\msedge.exe") ?? First(@"Google\Chrome\Application\chrome.exe");
    }

    static string First(string relative)
    {
        foreach (string var in new[] { "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LocalAppData" })
        {
            string dir = Environment.GetEnvironmentVariable(var);
            if (!string.IsNullOrEmpty(dir) && File.Exists(Path.Combine(dir, relative))) return Path.Combine(dir, relative);
        }
        return null;
    }

    static void Fail(string text)
    {
        MessageBox.Show(text, "Charts", MessageBoxButtons.OK, MessageBoxIcon.Warning);
    }
}

static class Job
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr a, string name);
    [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int type, ref Extended info, uint size);
    [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [StructLayout(LayoutKind.Sequential)]
    struct Basic
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Extended
    {
        public Basic Basic;
        public ulong R1, R2, R3, R4, R5, R6;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    static IntPtr handle;
    public static void Attach(Process p)
    {
        handle = CreateJobObject(IntPtr.Zero, null);
        Extended info = new Extended();
        info.Basic.LimitFlags = 0x2000; // kill processes when the owner closes
        SetInformationJobObject(handle, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended)));
        AssignProcessToJobObject(handle, p.Handle);
    }
}
