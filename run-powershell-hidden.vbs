Option Explicit

Dim shell, scriptPath, powershellPath, command, exitCode

If WScript.Arguments.Count <> 1 Then
  WScript.Quit 2
End If

Set shell = CreateObject("WScript.Shell")
scriptPath = WScript.Arguments(0)
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")

command = Chr(34) & powershellPath & Chr(34) & _
  " -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File " & _
  Chr(34) & Replace(scriptPath, Chr(34), Chr(34) & Chr(34)) & Chr(34)

exitCode = shell.Run(command, 0, True)
WScript.Quit exitCode
