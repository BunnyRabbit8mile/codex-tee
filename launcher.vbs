Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Wscript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = dir
shell.Run "powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File """ & dir & "\watchdog.ps1""", 0, False
