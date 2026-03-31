import paramiko

host = "163.227.174.141"
username = "empcloud-development"
ssh_pass = "rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

sql = "DESCRIBE Task;"
cmd = f'mysql -u admin -ppassword123 gbscrm -e "{sql}" 2>&1'

ssh = paramiko.SSHClient()
ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
ssh.connect(host, username=username, password=ssh_pass, timeout=30)
stdin, stdout, stderr = ssh.exec_command(cmd, timeout=30)
out = stdout.read().decode()
err = stderr.read().decode()
print("OUT:", out)
print("ERR:", err)
ssh.close()
