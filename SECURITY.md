# Security Policy

## Supported Versions

Only the current `main` branch is supported while the project is pre-1.0.

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories when
available, or by contacting the maintainer listed on the GitHub repository.

## Chrome DevTools Protocol Exposure

Chrome DevTools Protocol grants full control over the attached browser profile.
Do not expose its port to untrusted networks.

`agent-browser` launches an isolated Chrome profile and, on WSL2, creates a
Windows-side TCP forwarder because Windows Chrome binds CDP to loopback. The
forwarder binds to the Windows host address reachable from WSL instead of all
interfaces. Treat that address as local development infrastructure and stop the
browser with `ab chrome-stop` when finished.
