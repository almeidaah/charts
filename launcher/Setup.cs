// Charts setup: a single file with the program and Node embedded. Installs for the current user only.
// Silent use: setup.exe /quiet [/dir="C:\folder"] [/nodesktop]
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32;

[assembly: AssemblyTitle("Charts Setup")]
[assembly: AssemblyProduct("Charts")]
[assembly: AssemblyVersion("1.3.2.0")]

static class Setup
{
    const string Version = "1.3.2";
    const string PingUrl = "http://127.0.0.1:5180/api/ping";
    static bool quiet, noDesktop;
    static string dir, shortcutsDir, regKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\Charts";

    [STAThread]
    static int Main(string[] args)
    {
        dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Programs\Charts");
        foreach (string a in args)
        {
            if (a == "/quiet") quiet = true;
            else if (a == "/nodesktop") noDesktop = true;
            else if (a.StartsWith("/dir=")) dir = a.Substring(5);
            else if (a.StartsWith("/test="))
            {   // tests only: leaves the real shortcuts and registry alone
                shortcutsDir = a.Substring(6);
                regKey = @"Software\ChartsSetupTest";
            }
        }
        if (quiet)
        {
            try { Install(dir, !noDesktop, delegate { }); return 0; }
            catch (Exception e) { Console.Error.WriteLine(e.Message); return 1; }
        }
        Application.EnableVisualStyles();
        Application.Run(new Window());
        return 0;
    }

    class Window : Form
    {
        readonly TextBox path = new TextBox();
        readonly CheckBox desktop = new CheckBox(), run = new CheckBox();
        readonly Button go = new Button(), browse = new Button();
        readonly ProgressBar bar = new ProgressBar();
        readonly Label status = new Label();

        public Window()
        {
            Text = "Install Charts";
            Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
            Font = new Font("Segoe UI", 9.5f);
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96, 96);
            ClientSize = new Size(480, 262);
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            StartPosition = FormStartPosition.CenterScreen;

            Label title = new Label();
            title.Text = "Charts";
            title.Font = new Font("Segoe UI Semibold", 16f);
            title.SetBounds(20, 14, 440, 34);
            Label where = new Label();
            where.Text = "Install folder";
            where.SetBounds(22, 58, 300, 22);
            path.SetBounds(22, 82, 340, 26);
            path.Text = dir;
            browse.Text = "Browse…";
            browse.SetBounds(370, 81, 90, 28);
            browse.Click += delegate
            {
                using (FolderBrowserDialog d = new FolderBrowserDialog())
                    if (d.ShowDialog(this) == DialogResult.OK) path.Text = Path.Combine(d.SelectedPath, "Charts");
            };
            desktop.Text = "Create a desktop shortcut";
            desktop.Checked = true;
            desktop.SetBounds(22, 118, 400, 24);
            run.Text = "Open Charts when finished";
            run.Checked = true;
            run.SetBounds(22, 144, 400, 24);
            bar.SetBounds(22, 180, 438, 14);
            bar.Visible = false;
            status.SetBounds(22, 200, 330, 44);
            go.Text = "Install";
            go.SetBounds(360, 212, 100, 34);
            go.Click += delegate { Start(); };
            AcceptButton = go;
            Controls.AddRange(new Control[] { title, where, path, browse, desktop, run, bar, status, go });
        }

        void Start()
        {
            string target = path.Text.Trim();
            bool link = desktop.Checked;
            path.Enabled = browse.Enabled = desktop.Enabled = run.Enabled = go.Enabled = false;
            bar.Visible = true;
            status.Text = "Installing…";
            Thread t = new Thread(delegate()
            {
                Exception error = null;
                try { Install(target, link, delegate(int pct) { BeginInvoke((Action)delegate { bar.Value = pct; }); }); }
                catch (Exception e) { error = e; }
                BeginInvoke((Action)delegate
                {
                    if (error != null)
                    {
                        MessageBox.Show(this, error.Message, "Charts", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        path.Enabled = browse.Enabled = desktop.Enabled = run.Enabled = go.Enabled = true;
                        bar.Visible = false;
                        status.Text = "";
                        return;
                    }
                    if (run.Checked) Process.Start(Path.Combine(target, "charts.exe"));
                    else MessageBox.Show(this, "Charts was installed.", "Charts");
                    Close();
                });
            });
            t.IsBackground = true;
            t.Start();
        }
    }

    static void Install(string target, bool desktopLink, Action<int> progress)
    {
        if (!Path.IsPathRooted(target)) throw new Exception("Choose a valid folder.");
        target = Path.GetFullPath(target).TrimEnd('\\');
        if (shortcutsDir == null && Running()) throw new Exception("Charts is open. Close its window and try again.");
        // Never mix with a folder that holds something else.
        if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length > 0
            && !File.Exists(Path.Combine(target, "charts.exe")) && !File.Exists(Path.Combine(target, @"data\market.db")))
            throw new Exception("That folder already has other files. Choose an empty folder.");

        Directory.CreateDirectory(target);
        string root = target + "\\";
        using (Stream s = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
        using (ZipArchive zip = new ZipArchive(s, ZipArchiveMode.Read))
        {
            long total = 0, done = 0;
            foreach (ZipArchiveEntry e in zip.Entries) total += e.Length;
            foreach (ZipArchiveEntry e in zip.Entries)
            {
                string file = Path.GetFullPath(Path.Combine(root, e.FullName));
                if (!file.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("Invalid package.");
                if (e.FullName.EndsWith("/") || e.FullName.EndsWith("\\")) { Directory.CreateDirectory(file); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(file));
                using (Stream src = e.Open())
                using (FileStream dst = File.Create(file))
                {
                    byte[] buf = new byte[1 << 20];
                    int n;
                    while ((n = src.Read(buf, 0, buf.Length)) > 0)
                    {
                        dst.Write(buf, 0, n);
                        done += n;
                        progress((int)Math.Min(100, done * 100 / Math.Max(1, total)));
                    }
                }
            }
        }

        // Data next to setup (portable folder) comes along, never overwriting existing data.
        string mine = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), @"data\market.db");
        string theirs = Path.Combine(target, @"data\market.db");
        if (File.Exists(mine) && !File.Exists(theirs))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(theirs));
            foreach (string ext in new[] { "-wal", "" }) if (File.Exists(mine + ext)) File.Copy(mine + ext, theirs + ext);
        }

        string exe = Path.Combine(target, "charts.exe");
        string menu = Path.Combine(shortcutsDir ?? Environment.GetFolderPath(Environment.SpecialFolder.Programs), "Charts.lnk");
        string desk = Path.Combine(shortcutsDir ?? Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), shortcutsDir == null ? "Charts.lnk" : "Charts-desktop.lnk");
        Shortcut(menu, exe, target);
        if (desktopLink) Shortcut(desk, exe, target);
        File.WriteAllLines(Path.Combine(target, "install.txt"),
            desktopLink ? new[] { regKey, menu, desk } : new[] { regKey, menu }, Encoding.UTF8);

        using (RegistryKey k = Registry.CurrentUser.CreateSubKey(regKey))
        {
            k.SetValue("DisplayName", "Charts");
            k.SetValue("DisplayVersion", Version);
            k.SetValue("DisplayIcon", exe);
            k.SetValue("InstallLocation", target);
            k.SetValue("UninstallString", "\"" + exe + "\" --uninstall");
            k.SetValue("EstimatedSize", 100 * 1024, RegistryValueKind.DWord);
            k.SetValue("NoModify", 1, RegistryValueKind.DWord);
            k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        }
    }

    static void Shortcut(string link, string exe, string dir)
    {
        Type type = Type.GetTypeFromProgID("WScript.Shell");
        object shell = Activator.CreateInstance(type);
        object lnk = type.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { link });
        Type t = lnk.GetType();
        t.InvokeMember("TargetPath", BindingFlags.SetProperty, null, lnk, new object[] { exe });
        t.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, lnk, new object[] { dir });
        t.InvokeMember("IconLocation", BindingFlags.SetProperty, null, lnk, new object[] { exe + ",0" });
        t.InvokeMember("Save", BindingFlags.InvokeMethod, null, lnk, null);
    }

    static bool Running()
    {
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(PingUrl);
            req.Proxy = null;
            req.Timeout = 1500;
            using (WebResponse res = req.GetResponse())
            using (StreamReader r = new StreamReader(res.GetResponseStream()))
                return r.ReadToEnd().Contains("charts-app");
        }
        catch (WebException) { return false; }
    }
}
