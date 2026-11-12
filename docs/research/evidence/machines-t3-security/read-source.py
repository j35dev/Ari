"""Read numbered immutable Git sources for this report; performs no writes."""
import subprocess
import sys

sha, path = sys.argv[1:3]
start = int(sys.argv[3]) if len(sys.argv) > 3 else 1
stop = int(sys.argv[4]) if len(sys.argv) > 4 else 10**9
blob = subprocess.check_output(["git", "rev-parse", f"{sha}:{path}"], text=True).strip()
source = subprocess.check_output(["git", "show", f"{sha}:{path}"], encoding="utf-8")
print(f"{sha} {path} blob={blob}")
for line, value in enumerate(source.splitlines(), 1):
    if start <= line <= stop:
        print(f"{line:5}: {value}")
