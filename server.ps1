# Grottmästaren – liten webbserver för iPad och andra enheter i hemmanätet.
# Kräver inget extra program. Stäng fönstret för att stänga av servern.
$ErrorActionPreference = 'Stop'
$port = 8077
$dir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$file = Join-Path $dir 'index.html'
$Host.UI.RawUI.WindowTitle = 'Grottmästaren – server'

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $port)
try { $listener.Start() } catch {
  Write-Host ''
  Write-Host "Port $port används redan. Servern är troligen redan igång i ett annat fönster." -ForegroundColor Yellow
  Write-Host ''
  Read-Host 'Tryck Enter för att stänga'
  exit
}

$ips = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
  Where-Object { $_.AddressFamily -eq 'InterNetwork' -and -not $_.ToString().StartsWith('169.254') -and -not $_.ToString().StartsWith('127.') } |
  ForEach-Object { $_.ToString() }

Write-Host ''
Write-Host '  GROTTMÄSTAREN ÄR IGÅNG' -ForegroundColor Yellow
Write-Host ''
Write-Host '  Skriv in den här adressen i Safari på iPaden:' -ForegroundColor Gray
foreach ($ip in $ips) { Write-Host "     http://${ip}:$port" -ForegroundColor Green }
Write-Host ''
Write-Host "  På den här datorn: http://localhost:$port" -ForegroundColor Gray
Write-Host ''
Write-Host '  iPaden måste vara på samma wifi som datorn.' -ForegroundColor Gray
Write-Host '  Låt fönstret vara öppet (det går bra att minimera det).' -ForegroundColor Gray
Write-Host '  Stäng fönstret för att stänga av servern.' -ForegroundColor Gray
Write-Host ''

$ascii = [System.Text.Encoding]::ASCII
while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 10000
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, $ascii, $false, 4096, $true)
    $first = $reader.ReadLine()
    if (-not $first) { continue }
    while ($true) { $h = $reader.ReadLine(); if ($h -eq $null -or $h -eq '') { break } }
    $parts = $first.Split(' ')
    $method = $parts[0]
    $path = if ($parts.Length -gt 1) { $parts[1].Split('?')[0] } else { '/' }
    if ($path -eq '/' -or $path -eq '/index.html') {
      $body = [System.IO.File]::ReadAllBytes($file)
      $type = 'text/html; charset=utf-8'
      $code = '200 OK'
    } else {
      $body = [System.Text.Encoding]::UTF8.GetBytes('Finns inte')
      $type = 'text/plain; charset=utf-8'
      $code = '404 Not Found'
    }
    $hdr = "HTTP/1.1 $code`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
    $hb = $ascii.GetBytes($hdr)
    $stream.Write($hb, 0, $hb.Length)
    if ($method -ne 'HEAD') { $stream.Write($body, 0, $body.Length) }
    $stream.Flush()
    if ($code -eq '200 OK') { Write-Host ("  {0}  Spelet öppnades från {1}" -f (Get-Date -Format 'HH:mm'), $client.Client.RemoteEndPoint.Address) -ForegroundColor DarkGray }
  } catch {
  } finally {
    $client.Close()
  }
}
