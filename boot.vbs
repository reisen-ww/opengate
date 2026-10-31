Option Explicit
' OpenGate boot launcher (independent from any other service's launcher).
' Window style 0 sets STARTUPINFO.wShowWindow = SW_HIDE at the OS level, so no
' console host (Windows Terminal is the Win11 default and it ignores
' -WindowStyle Hidden) can make a window appear.
'
' On Error Resume Next is deliberate: an unhandled runtime error here pops a
' MODAL dialog at logon and blocks until a human clicks it. Exit 1 instead --
' it lands in the task's Last Run Result. The task repeats every 10 minutes,
' so a transient failure self-heals.
' watchdog.mjs has built-in single-instance protection: it exits silently when
' port 8787 is already served, so repeated triggers are idempotent.
On Error Resume Next
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""E:\APP\opencodex\opengate\watchdog.mjs""", 0, False
If Err.Number <> 0 Then
  WScript.Quit 1
End If
WScript.Quit 0
