import paramiko
import sys

host = "163.227.174.141"
username = "empcloud-development"
ssh_pass = "rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

try:
    cmd = sys.argv[1]
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=username, password=ssh_pass, timeout=30)

    stdin, stdout, stderr = ssh.exec_command(cmd, timeout=60)
    out = stdout.read().decode()
    err = stderr.read().decode()

    if out: print(out)
    if err: print("STDERR:", err)

    ssh.close()
except Exception as e:
    print(f"Error: {e}")
