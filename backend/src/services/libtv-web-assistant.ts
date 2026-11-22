/** A readable Windows launcher. Tokens stay in memory and travel back in the browser POST. */
export function libtvWebAssistant(options: { state: string; expiresAt: number; callbackUrl: string }) {
  const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
  const script = `@echo off
set "DRAMA_LIBTV_AUTH_SCRIPT=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$text = Get-Content -LiteralPath $env:DRAMA_LIBTV_AUTH_SCRIPT -Raw -Encoding UTF8; & ([scriptblock]::Create($text.Substring($text.LastIndexOf('# POWERSHELL-BEGIN'))))"
set "DRAMA_LIBTV_AUTH_SCRIPT="
exit /b
# POWERSHELL-BEGIN
$ErrorActionPreference = 'Stop'
$state = ${literal(options.state)}
$expiresAt = ${options.expiresAt}
$returnUrl = ${literal(options.callbackUrl)}
$listener = $null
$client = $null
try {
  $remaining = $expiresAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  if ($remaining -le 0) { throw '授权已过期，请返回应用重新连接。' }
  $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  $port = $listener.LocalEndpoint.Port
  $callback = 'http://127.0.0.1:' + $port + '/callback?state=' + $state + '&expires_at=' + $expiresAt
  $loginUrl = 'https://www.liblib.tv/zh?callback_url=' + [Uri]::EscapeDataString($callback)
  Write-Host '正在打开 LibTV 官方登录页，请选择任意可用的登录方式。'
  Start-Process $loginUrl
  while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $expiresAt) {
    $pending = $listener.AcceptTcpClientAsync()
    $wait = [int][Math]::Min(300000, $expiresAt - [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
    if ($wait -le 0 -or -not $pending.Wait($wait)) { throw '授权等待超时，请返回应用重新连接。' }
    $client = $pending.Result
    $client.ReceiveTimeout = 5000
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    $headerLength = 0
    do {
      $header = $reader.ReadLine()
      if ($null -eq $header) { throw '浏览器请求无效。' }
      $headerLength += $header.Length
      if ($headerLength -gt 32768) { throw '浏览器请求过长。' }
    } while ($header -ne '')
    $valid = $false
    $token = ''
    if ($requestLine -match '^GET ([^ ]{1,32768}) HTTP/1\\.[01]$') {
      $url = New-Object Uri(('http://127.0.0.1:' + $port + $Matches[1]))
      $query = @{}
      foreach ($part in $url.Query.TrimStart('?').Split('&')) {
        $pair = $part.Split('=', 2)
        if ($pair.Length -eq 2) { $query[[Uri]::UnescapeDataString($pair[0])] = [Uri]::UnescapeDataString($pair[1]) }
      }
      if ($url.AbsolutePath -eq '/callback' -and $query['state'] -ceq $state -and $query['token']) {
        $token = [string]$query['token']
        $valid = $token.Length -le 16384 -and $token -notmatch '[\\x00-\\x20\\x7f]'
      }
    }
    if ($valid) {
      $encode = [System.Net.WebUtility]
      $action = $encode::HtmlEncode($returnUrl)
      $safeState = $encode::HtmlEncode($state)
      $safeToken = $encode::HtmlEncode($token)
      $nonce = [Guid]::NewGuid().ToString('N')
      $html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>返回 LibTV 授权</title><form method="post" action="' + $action + '"><input type="hidden" name="state" value="' + $safeState + '"><input type="hidden" name="token" value="' + $safeToken + '"><p>登录已完成，正在返回应用授权。</p><button type="submit">返回应用并完成授权</button></form><script nonce="' + $nonce + '">history.replaceState(null,"","/callback");document.forms[0].submit()</script></html>'
      $policy = "default-src 'none'; script-src 'nonce-" + $nonce + "'; form-action " + ([Uri]$returnUrl).GetLeftPart([UriPartial]::Authority) + "; base-uri 'none'; frame-ancestors 'none'"
      $status = '200 OK'
    } else {
      $html = '授权回调无效，请在官方登录页面完成登录。'
      $policy = "default-src 'none'"
      $status = '400 Bad Request'
    }
    $body = [Text.Encoding]::UTF8.GetBytes($html)
    $headers = 'HTTP/1.1 ' + $status + "\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nConnection: close\r\nContent-Security-Policy: " + $policy + "\r\nContent-Length: " + $body.Length + "\r\n\r\n"
    $head = [Text.Encoding]::ASCII.GetBytes($headers)
    $stream.Write($head, 0, $head.Length)
    $stream.Write($body, 0, $body.Length)
    $stream.Flush()
    $client.Close()
    $client = $null
    if ($valid) { Write-Host '已返回应用，账号状态会自动刷新，可以关闭此窗口。'; break }
  }
} catch {
  Write-Host 'LibTV 本机授权未完成，请返回应用重新连接。'
  Start-Sleep -Seconds 5
} finally {
  if ($client) { $client.Close() }
  if ($listener) { $listener.Stop() }
  $token = $null
  $query = $null
}
`
  return script.replace(/\r?\n/gu, '\r\n')
}
