using Onda;
using Onda.Components;
using Onda.Models;
using Onda.Services;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.Caching.Memory;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.Logging.AddConsole();
builder.Logging.AddDebug();

var mediaOptions = builder.Configuration.GetSection("Media").Get<MediaOptions>() ?? new MediaOptions();
mediaOptions.Normalize();
var storageOptions = builder.Configuration.GetSection("Storage").Get<StorageOptions>() ?? new StorageOptions();

builder.Services.AddSingleton(mediaOptions);
builder.Services.AddSingleton(storageOptions);
builder.Services.AddSingleton<ChatStore>();
builder.Services.AddSingleton<LiveKitTokenService>();
builder.Services.AddRazorComponents()
    .AddInteractiveServerComponents();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<RoomService>();
builder.Services.AddSingleton<GuestIdentityStore>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<GuestSession>();
builder.Services.AddScoped<ToastService>();
builder.Services.AddHostedService<RoomJanitor>();
builder.Services.AddMemoryCache();
builder.Services.AddHttpClient("github", client =>
{
    client.Timeout = TimeSpan.FromSeconds(10);
    client.DefaultRequestHeaders.UserAgent.ParseAdd("OndaWeb/1.0");
});

var app = builder.Build();

app.Logger.LogInformation(
    "Media provider: {Provider}. Room capacity: {Capacity}. LiveKit URL: {LiveKitUrl}.",
    mediaOptions.EffectiveProvider,
    mediaOptions.EffectiveMaxParticipants,
    mediaOptions.IsLiveKitConfigured ? mediaOptions.LiveKit.Url : "(not configured)");

if (!app.Environment.IsDevelopment())
{
    app.UseExceptionHandler("/Error", createScopeForErrors: true);
    app.UseHsts();
}

app.UseStatusCodePagesWithReExecute("/not-found", createScopeForStatusCodePages: true);
if (!app.Environment.IsDevelopment() &&
    app.Configuration.GetValue("HttpsRedirection:Enabled", true))
{
    app.UseHttpsRedirection();
}

app.Use(async (context, next) =>
{
    var store = context.RequestServices.GetRequiredService<GuestIdentityStore>();
    var token = context.Request.Cookies[GuestIdentityStore.CookieName];
    if (string.IsNullOrWhiteSpace(token))
    {
        store.CreateForNewToken(out token);
        context.Response.Cookies.Append(
            GuestIdentityStore.CookieName,
            token,
            new CookieOptions
            {
                HttpOnly = true,
                Secure = context.Request.IsHttps,
                SameSite = SameSiteMode.Lax,
                Path = "/",
                Expires = DateTimeOffset.UtcNow.AddYears(1)
            });
    }

    context.Items[GuestIdentityStore.CookieName] = token;
    await next();
});

app.UseAntiforgery();

app.Use(async (context, next) =>
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "same-origin";
    context.Response.Headers["Permissions-Policy"] = "camera=(self), microphone=(self), display-capture=(self)";
    await next();
});

// Social crawlers do not execute Blazor. Serve a small HTML shell with the
// room-specific Open Graph data so WhatsApp, Telegram and similar apps can
// render a useful preview for shared room links.
app.Use(async (context, next) =>
{
    if ((!HttpMethods.IsGet(context.Request.Method) && !HttpMethods.IsHead(context.Request.Method)) ||
        !context.Request.Path.StartsWithSegments("/sala", out var remaining))
    {
        await next();
        return;
    }

    var userAgent = context.Request.Headers.UserAgent.ToString();
    if (!LooksLikeSocialCrawler(userAgent))
    {
        await next();
        return;
    }

    var code = remaining.Value?.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries)
        .FirstOrDefault();
    if (string.IsNullOrWhiteSpace(code))
    {
        await next();
        return;
    }

    var roomService = context.RequestServices.GetRequiredService<RoomService>();
    var room = roomService.GetSnapshot(code);
    if (room is null)
    {
        await next();
        return;
    }

    static bool LooksLikeSocialCrawler(string userAgent)
    {
        string[] markers =
        [
            "WhatsApp",
            "facebookexternalhit",
            "Facebot",
            "Twitterbot",
            "TelegramBot",
            "Slackbot",
            "Discordbot",
            "LinkedInBot",
            "Pinterest",
            "SkypeUriPreview",
            "Applebot",
            "Embedly",
            "Quora Link Preview",
            "redditbot"
        ];

        return markers.Any(marker => userAgent.Contains(marker, StringComparison.OrdinalIgnoreCase));
    }

    var encoder = System.Text.Encodings.Web.HtmlEncoder.Default;
    var title = $"{room.Name} no Onda";
    var description = room.Participants.Count == 0
        ? "Entre nesta sala do Onda para conversar por voz, compartilhar a tela e trocar mensagens."
        : $"{room.Participants.Count} pessoa{(room.Participants.Count == 1 ? "" : "s")} na sala. Entre pelo link para conversar por voz, compartilhar a tela e trocar mensagens.";
    var roomUrl = $"https://onda.dpbr.net/sala/{Uri.EscapeDataString(room.Id)}";
    var imageUrl = "https://onda.dpbr.net/og/onda-share.png?v=1";
    var html = $"""
        <!doctype html>
        <html lang="pt-BR">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>{encoder.Encode(title)}</title>
          <meta name="description" content="{encoder.Encode(description)}" />
          <meta property="og:site_name" content="Onda" />
          <meta property="og:title" content="{encoder.Encode(title)}" />
          <meta property="og:description" content="{encoder.Encode(description)}" />
          <meta property="og:type" content="website" />
          <meta property="og:locale" content="pt_BR" />
          <meta property="og:url" content="{encoder.Encode(roomUrl)}" />
          <meta property="og:image" content="{encoder.Encode(imageUrl)}" />
          <meta property="og:image:secure_url" content="{encoder.Encode(imageUrl)}" />
          <meta property="og:image:type" content="image/png" />
          <meta property="og:image:width" content="1200" />
          <meta property="og:image:height" content="630" />
          <meta property="og:image:alt" content="Onda: conversas que fluem. Voz, tela e presença no navegador, no Windows e no Android." />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content="{encoder.Encode(title)}" />
          <meta name="twitter:description" content="{encoder.Encode(description)}" />
          <meta name="twitter:image" content="{encoder.Encode(imageUrl)}" />
          <link rel="image_src" href="{encoder.Encode(imageUrl)}" />
          <link rel="canonical" href="{encoder.Encode(roomUrl)}" />
        </head>
        <body>
          <p><a href="{encoder.Encode(roomUrl)}">Abrir a sala {encoder.Encode(room.Name)} no Onda</a></p>
        </body>
        </html>
        """;

    context.Response.StatusCode = StatusCodes.Status200OK;
    context.Response.ContentType = "text/html; charset=utf-8";
    context.Response.Headers.CacheControl = "public,max-age=60";
    if (HttpMethods.IsHead(context.Request.Method))
    {
        return;
    }

    await context.Response.WriteAsync(html, context.RequestAborted);
});

app.MapStaticAssets();
var staticContentTypes = new FileExtensionContentTypeProvider();
staticContentTypes.Mappings[".webmanifest"] = "application/manifest+json";
app.UseStaticFiles(new StaticFileOptions
{
    ContentTypeProvider = staticContentTypes
});
app.MapPresenceEndpoints();
app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    mediaProvider = mediaOptions.EffectiveProvider,
    capacity = mediaOptions.EffectiveMaxParticipants,
    chatStorage = "sqlite"
})).AllowAnonymous();

app.MapGet("/api/rooms/{code}/exists", (string code, RoomService rooms) =>
{
    return Results.Ok(new { exists = rooms.RoomExists(code) });
}).AllowAnonymous();

app.MapGet("/download/android", async (
    IHttpClientFactory httpClientFactory,
    IMemoryCache memoryCache,
    CancellationToken cancellationToken) =>
{
    const string releasesPage = "https://github.com/raiancollyn/ondaMobile/releases/latest";
    const string cacheKey = "onda-android-apk-download";

    if (memoryCache.TryGetValue(cacheKey, out string? cachedUrl) &&
        !string.IsNullOrWhiteSpace(cachedUrl))
    {
        return Results.Redirect(cachedUrl);
    }

    try
    {
        var client = httpClientFactory.CreateClient("github");
        using var response = await client.GetAsync(
            "https://api.github.com/repos/raiancollyn/ondaMobile/releases/latest",
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            app.Logger.LogWarning(
                "GitHub release lookup returned {StatusCode} for the Android download.",
                response.StatusCode);
            return Results.Redirect(releasesPage);
        }

        using var document = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(cancellationToken));

        string? downloadUrl = null;
        if (document.RootElement.TryGetProperty("assets", out var assets))
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var nameElement)
                    ? nameElement.GetString()
                    : null;

                if (string.IsNullOrWhiteSpace(name) ||
                    !name.EndsWith(".apk", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                downloadUrl = asset.TryGetProperty("browser_download_url", out var urlElement)
                    ? urlElement.GetString()
                    : null;

                if (!string.IsNullOrWhiteSpace(downloadUrl))
                {
                    break;
                }
            }
        }

        if (string.IsNullOrWhiteSpace(downloadUrl))
        {
            return Results.Redirect(releasesPage);
        }

        memoryCache.Set(cacheKey, downloadUrl, TimeSpan.FromMinutes(10));
        return Results.Redirect(downloadUrl);
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning(ex, "Could not resolve the latest Android APK.");
        return Results.Redirect(releasesPage);
    }
}).AllowAnonymous();

app.MapGet("/download/desktop", async (
    IHttpClientFactory httpClientFactory,
    IMemoryCache memoryCache,
    CancellationToken cancellationToken) =>
{
    const string releasesPage = "https://github.com/raiancollyn/ondaDesktop/releases/latest";
    const string cacheKey = "onda-desktop-installer-download";

    if (memoryCache.TryGetValue(cacheKey, out string? cachedUrl) &&
        !string.IsNullOrWhiteSpace(cachedUrl))
    {
        return Results.Redirect(cachedUrl);
    }

    try
    {
        var client = httpClientFactory.CreateClient("github");
        using var response = await client.GetAsync(
            "https://api.github.com/repos/raiancollyn/ondaDesktop/releases/latest",
            cancellationToken);

        if (!response.IsSuccessStatusCode)
        {
            app.Logger.LogWarning(
                "GitHub release lookup returned {StatusCode} for the desktop download.",
                response.StatusCode);
            return Results.Redirect(releasesPage);
        }

        using var document = JsonDocument.Parse(
            await response.Content.ReadAsStringAsync(cancellationToken));

        string? downloadUrl = null;
        if (document.RootElement.TryGetProperty("assets", out var assets))
        {
            foreach (var asset in assets.EnumerateArray())
            {
                var name = asset.TryGetProperty("name", out var nameElement)
                    ? nameElement.GetString()
                    : null;

                if (string.IsNullOrWhiteSpace(name) ||
                    !name.StartsWith("Onda-Setup-", StringComparison.OrdinalIgnoreCase) ||
                    !name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                downloadUrl = asset.TryGetProperty("browser_download_url", out var urlElement)
                    ? urlElement.GetString()
                    : null;

                if (!string.IsNullOrWhiteSpace(downloadUrl))
                {
                    break;
                }
            }
        }

        if (string.IsNullOrWhiteSpace(downloadUrl))
        {
            return Results.Redirect(releasesPage);
        }

        memoryCache.Set(cacheKey, downloadUrl, TimeSpan.FromMinutes(10));
        return Results.Redirect(downloadUrl);
    }
    catch (Exception ex)
    {
        app.Logger.LogWarning(ex, "Could not resolve the latest desktop installer.");
        return Results.Redirect(releasesPage);
    }
}).AllowAnonymous();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
