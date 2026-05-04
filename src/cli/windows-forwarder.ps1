# agent-browser WSL->Windows CDP forwarder
#
# Chrome on Windows silently refuses `--remote-debugging-address=0.0.0.0` for
# security reasons, so CDP only listens on 127.0.0.1 — unreachable from the
# WSL2 VM. This script runs on the Windows host and relays <ListenAddress>:<ListenPort>
# to 127.0.0.1:<TargetPort>, letting WSL agents hit CDP via the WSL gateway IP.
#
# Runs entirely in-process via Add-Type compiled C# (works on Windows
# PowerShell 5.1 — no PS7 or external deps). Background-friendly; the caller
# should launch this via `Start-Process -WindowStyle Hidden` and capture the
# PID so it can be killed later.
#
# Args:
#   -ListenAddress address to listen on. default 127.0.0.1
#   -ListenPort    port to listen on. default 9223
#   -TargetPort    port to forward to (127.0.0.1:<port>). default 9222
#   -PidFile       path to write the pid into so the launcher can stop us later
param(
    [string]$ListenAddress = '127.0.0.1',
    [int]$ListenPort = 9223,
    [int]$TargetPort = 9222,
    [string]$PidFile = ''
)

if ($PidFile) {
    $PID | Out-File -FilePath $PidFile -Encoding ascii -Force
}

Add-Type -Language CSharp -TypeDefinition @"
using System;
using System.Net;
using System.Net.Sockets;
using System.Threading.Tasks;

public static class AbForwarder {
    public static void Run(string listenAddress, int listenPort, string targetHost, int targetPort) {
        IPAddress listenIp;
        if (!IPAddress.TryParse(listenAddress, out listenIp)) {
            throw new ArgumentException("Invalid listen address: " + listenAddress);
        }
        var listener = new TcpListener(listenIp, listenPort);
        listener.Start();
        while (true) {
            var client = listener.AcceptTcpClient();
            Task.Run(() => Handle(client, targetHost, targetPort));
        }
    }

    static void Handle(TcpClient client, string targetHost, int targetPort) {
        TcpClient upstream = null;
        try {
            upstream = new TcpClient(targetHost, targetPort);
            var cs = client.GetStream();
            var us = upstream.GetStream();
            var t1 = cs.CopyToAsync(us);
            var t2 = us.CopyToAsync(cs);
            Task.WaitAny(new Task[] { t1, t2 });
        } catch { }
        finally {
            try { if (upstream != null) upstream.Close(); } catch { }
            try { client.Close(); } catch { }
        }
    }
}
"@

Write-Host "agent-browser forwarder listening on ${ListenAddress}:$ListenPort -> 127.0.0.1:$TargetPort"
[AbForwarder]::Run($ListenAddress, $ListenPort, '127.0.0.1', $TargetPort)
