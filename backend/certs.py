"""Use the operating system's certificate store for HTTPS (Hugging Face downloads).

On university/NHS/corporate networks a security proxy re-signs HTTPS traffic with an in-house certificate.
Browsers trust it (IT installs it in Windows/macOS), but Python's bundled certificates do not, giving
"CERTIFICATE_VERIFY_FAILED: self signed certificate in certificate chain". truststore makes Python verify
against the OS store instead — verification stays ON; it just uses the same trust as your browser.
Disable with PORTAL_SYSTEM_CERTS=0."""
import os

ACTIVE = False
if os.environ.get("PORTAL_SYSTEM_CERTS", "1") != "0":
    try:
        import truststore  # pip install truststore (Python >= 3.10)
        truststore.inject_into_ssl()
        ACTIVE = True
    except Exception:
        pass
