import paramiko

host = "163.227.174.141"
username = "empcloud-development"
ssh_pass = "rSPa3izkYPtAjCFLa5cqPDpsFvV071KN9u"
maint_user = "debian-sys-maint"
maint_pass = "RGP6yyWMEdI0yguZ"

try:
    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    ssh.connect(host, username=username, password=ssh_pass)
    
    print("Provisioning MySQL Database `gbscrm`...")
    cmd_db = f"mysql -u {maint_user} -p'{maint_pass}' -e 'CREATE DATABASE IF NOT EXISTS gbscrm;'"
    ssh.exec_command(cmd_db)
    
    print("Provisioning MySQL User `admin`...")
    cmd_usr = f"mysql -u {maint_user} -p'{maint_pass}' -e \"CREATE USER IF NOT EXISTS 'admin'@'localhost' IDENTIFIED BY 'password123'; GRANT ALL PRIVILEGES ON gbscrm.* TO 'admin'@'localhost'; FLUSH PRIVILEGES;\""
    ssh.exec_command(cmd_usr)

    print("Updating production .env file...")
    env_content = 'DATABASE_URL="mysql://admin:password123@localhost:3306/gbscrm"'
    ssh.exec_command(f"echo '{env_content}' > /home/empcloud-development/globussoft-crm/backend/.env")

    print(f"Updating production schema.prisma...")
    sftp = ssh.open_sftp()
    sftp.put(r"c:\Users\Admin\gbs-projects\gbs-crm\backend\prisma\schema.prisma", "/home/empcloud-development/globussoft-crm/backend/prisma/schema.prisma")
    sftp.close()

    print("Running npx prisma db push on server...")
    stdin, stdout, stderr = ssh.exec_command("export NVM_DIR=\"$HOME/.nvm\"; [ -s \"$NVM_DIR/nvm.sh\" ] && \\. \"$NVM_DIR/nvm.sh\"; cd /home/empcloud-development/globussoft-crm/backend; npm install prisma@6.4.1 @prisma/client@6.4.1; npx prisma@6.4.1 db push --accept-data-loss")
    print("PRISMA STDOUT:", stdout.read().decode())
    print("PRISMA STDERR:", stderr.read().decode())

    print("Restarting pm2 backend...")
    ssh.exec_command("export NVM_DIR=\"$HOME/.nvm\"; [ -s \"$NVM_DIR/nvm.sh\" ] && \\. \"$NVM_DIR/nvm.sh\"; cd /home/empcloud-development/globussoft-crm/backend; npx pm2 restart globussoft-crm-backend")

    ssh.close()
    print("Database Migration to MySQL completed!")
except Exception as e:
    print(f"Error: {e}")
