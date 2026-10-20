' TAGLITE silent launcher.
' Same as PLAY.bat but with no console window at all - the browser just opens.
' Use PLAY.bat instead for the very first run, so you can see install progress
' and any error messages.
Option Explicit

Dim fso, sh, here
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
here = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = here

If Not fso.FolderExists(fso.BuildPath(here, "node_modules")) Then
  ' Dependencies missing - run visibly so the install isn't a silent wait.
  sh.Run "cmd /c """ & fso.BuildPath(here, "PLAY.bat") & """", 1, False
Else
  sh.Run "cmd /c """ & fso.BuildPath(here, "PLAY.bat") & """", 0, False
End If
