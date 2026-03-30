import paramiko
import os
import glob

host = "163.227.174.141"
username = "empcloud-development"
ssh_pass = "rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"

try:
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=username, password=ssh_pass)
    sftp = ssh.open_sftp()
    
    print("Uploading backend/server.js ...")
    sftp.put(r"c:\Users\Admin\gbs-projects\gbs-crm\backend\server.js", "/home/empcloud-development/globussoft-crm/backend/server.js")
    
    # Upload all routes
    routes_dir = r"c:\Users\Admin\gbs-projects\gbs-crm\backend\routes"
    for file in glob.glob(os.path.join(routes_dir, "*.js")):
        filename = os.path.basename(file)
        print(f"Uploading backend/routes/{filename} ...")
        sftp.put(file, f"/home/empcloud-development/globussoft-crm/backend/routes/{filename}")

    # Upload middleware just in case
    middleware_dir = r"c:\Users\Admin\gbs-projects\gbs-crm\backend\middleware"
    if os.path.exists(middleware_dir):
        for file in glob.glob(os.path.join(middleware_dir, "*.js")):
            filename = os.path.basename(file)
            print(f"Uploading backend/middleware/{filename} ...")
            sftp.put(file, f"/home/empcloud-development/globussoft-crm/backend/middleware/{filename}")

    sftp.close()

    print("Restarting the backend node process via PM2...")
    stdin, stdout, stderr = ssh.exec_command("export NVM_DIR=\"$HOME/.nvm\"; [ -s \"$NVM_DIR/nvm.sh\" ] && \\. \"$NVM_DIR/nvm.sh\"; cd /home/empcloud-development/globussoft-crm/backend; npx pm2 restart globussoft-crm-backend")
    
    print("Backend Deployment completed successfully.")
    ssh.close()
except Exception as e:
    print(f"Deployment Failed: {e}")
