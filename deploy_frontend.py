import paramiko
import time

host = "163.227.174.141"
username = "empcloud-development"
ssh_pass = "rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

import subprocess

try:
    print("Zipping frontend/dist ...")
    subprocess.run(["powershell", "-Command", "Compress-Archive -Path frontend\\dist\\* -DestinationPath frontend\\dist.zip -Force"], check=True)
    
    print("Connecting to server...")
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=username, password=ssh_pass)
    
    sftp = ssh.open_sftp()
    
    print("Uploading frontend/dist.zip ...")
    sftp.put(r"c:\Users\Admin\gbs-projects\gbs-crm\frontend\dist.zip", "/home/empcloud-development/dist.zip")
    
    sftp.close()

    print("Unzipping to /var/www/crm.globusdemos.com/ ...")
    commands = [
        "sudo -S unzip -o /home/empcloud-development/dist.zip -d /var/www/crm.globusdemos.com/",
        "sudo -S chown -R www-data:www-data /var/www/crm.globusdemos.com/",
        "rm /home/empcloud-development/dist.zip"
    ]
    
    for cmd in commands:
        stdin, stdout, stderr = ssh.exec_command(cmd)
        stdin.write(ssh_pass + "\n")
        stdin.flush()
        cmd_parts = cmd.split()
        exe = cmd_parts[2] if len(cmd_parts) > 2 else cmd_parts[0]
        print(f"Executed: {exe}")
        out = stdout.read().decode().strip()
        err = stderr.read().decode().strip()
        if err and "password" not in err.lower():
            print(f"Warning/Error: {err}")
    
    print("Frontend Deployment completed successfully.")
    ssh.close()
except Exception as e:
    print(f"Deployment Failed: {e}")
