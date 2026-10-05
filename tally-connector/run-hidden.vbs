Option Explicit

Dim shell, fileSystem, folder, executable
Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")
folder = fileSystem.GetParentFolderName(WScript.ScriptFullName)
executable = fileSystem.BuildPath(folder, "TallyConnector.exe")

shell.CurrentDirectory = folder
shell.Run Chr(34) & executable & Chr(34), 0, False
