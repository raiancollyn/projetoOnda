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

var lifetime = app.Services.GetRequiredService<IHostApplicationLifetime>();
lifetime.ApplicationStopping.Register(() =>
{
    try
    {
        app.Services.GetRequiredService<ChatStore>().ClearAllRooms();
    }
    catch (Exception ex)
    {
        app.Logger.LogError(ex, "Could not clear the SQLite room store during shutdown.");
    }
});

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

app.UseAntiforgery();

app.Use(async (context, next) =>
{
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "same-origin";
    context.Response.Headers["Permissions-Policy"] = "camera=(self), microphone=(self), display-capture=(self)";
    await next();
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
