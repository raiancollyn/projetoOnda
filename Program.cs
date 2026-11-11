using Onda;
using Onda.Components;
using Onda.Models;
using Onda.Services;

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
app.MapPresenceEndpoints();
app.MapGet("/health", () => Results.Ok(new
{
    status = "ok",
    mediaProvider = mediaOptions.EffectiveProvider,
    capacity = mediaOptions.EffectiveMaxParticipants,
    chatStorage = "sqlite"
})).AllowAnonymous();

app.MapRazorComponents<App>()
    .AddInteractiveServerRenderMode();

app.Run();
