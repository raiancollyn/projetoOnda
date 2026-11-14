using Onda.Services;

namespace Onda;

public static class PresenceEndpoints
{
    public sealed record PresencePing(string RoomId, string GuestId);

    public sealed record NativeMediaPing(
        string RoomId,
        string GuestId,
        string? Name,
        int AvatarTone);

    public sealed record MediaStatePing(
        string RoomId,
        string GuestId,
        bool MicOn,
        bool CameraOn,
        bool ScreenOn,
        bool ScreenWithAudio);

    public sealed record SpeakingPing(
        string RoomId,
        string GuestId,
        bool Speaking);

    public static IEndpointRouteBuilder MapPresenceEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapPost("/api/presence/heartbeat", (PresencePing? ping, RoomService rooms) =>
        {
            if (ping is null ||
                string.IsNullOrWhiteSpace(ping.RoomId) ||
                string.IsNullOrWhiteSpace(ping.GuestId))
            {
                return Results.BadRequest();
            }

            rooms.Touch(ping.RoomId, ping.GuestId);
            return Results.NoContent();
        });

        endpoints.MapPost("/api/presence/native", (NativeMediaPing? ping, RoomService rooms) =>
        {
            if (ping is null ||
                string.IsNullOrWhiteSpace(ping.RoomId) ||
                string.IsNullOrWhiteSpace(ping.GuestId))
            {
                return Results.BadRequest();
            }

            rooms.TouchNativeMedia(ping.RoomId, ping.GuestId, ping.Name, ping.AvatarTone);
            return Results.NoContent();
        });

        endpoints.MapPost("/api/presence/media", (MediaStatePing? ping, RoomService rooms) =>
        {
            if (ping is null ||
                string.IsNullOrWhiteSpace(ping.RoomId) ||
                string.IsNullOrWhiteSpace(ping.GuestId))
            {
                return Results.BadRequest();
            }

            rooms.UpdateMediaState(
                ping.RoomId,
                ping.GuestId,
                ping.MicOn,
                ping.CameraOn,
                ping.ScreenOn,
                ping.ScreenWithAudio);
            return Results.NoContent();
        });

        endpoints.MapPost("/api/presence/speaking", (SpeakingPing? ping, RoomService rooms) =>
        {
            if (ping is null ||
                string.IsNullOrWhiteSpace(ping.RoomId) ||
                string.IsNullOrWhiteSpace(ping.GuestId))
            {
                return Results.BadRequest();
            }

            rooms.UpdateSpeaking(ping.RoomId, ping.GuestId, ping.Speaking);
            return Results.NoContent();
        });

        endpoints.MapPost("/api/presence/leave", (PresencePing? ping, RoomService rooms) =>
        {
            if (ping is null ||
                string.IsNullOrWhiteSpace(ping.RoomId) ||
                string.IsNullOrWhiteSpace(ping.GuestId))
            {
                return Results.BadRequest();
            }

            rooms.LeaveRoom(ping.RoomId, ping.GuestId);
            return Results.NoContent();
        });

        return endpoints;
    }
}
