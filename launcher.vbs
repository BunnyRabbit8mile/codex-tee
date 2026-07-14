' codex-tee silent launcher - runs the batch file without a console window
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("Wscript.Shell")
shell.CurrentDirectory = fso.GetParentFolderName(WScript.ScriptFullName)
shell.Run "cmd /c """" & fso.GetParentFolderName(WScript.ScriptFullName) & "\start-tee.bat""", 0, False
