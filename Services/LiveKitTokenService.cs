using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Onda.Models;

namespace Onda.Services;

/// <summary>
/// Issues short-lived LiveKit room access tokens without pulling in a JWT
/// dependency. Tokens are HS256-signed with the LiveKit API secret.
/// </summary>
public sealed class LiveKitTokenService(MediaOptions media, ILogger<LiveKitTokenService> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public string CreateRoomToken(string roomCode, string guestId, string guestName)
    {
        if (!media.IsLiveKitConfigured)
        {
            throw new InvalidOperationException("LiveKit não está configurado.");
        }

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var ttlSeconds = Math.Clamp(media.LiveKit.TokenTtlHours, 1, 24) * 3600;

        var payload = new
        {
            iss = media.LiveKit.ApiKey,
            sub = guestId,
            name = guestName,
            nbf = now - 10,
            iat = now - 10,
            exp = now + ttlSeconds,
            video = new
            {
                roomJoin = true,
                room = roomCode,
                canPublish = true,
                canSubscribe = true,
                canPublishData = true
            }
        };

        var headerJson = JsonSerializer.SerializeToUtf8Bytes(new { alg = "HS256", typ = "JWT" }, JsonOptions);
        var payloadJson = JsonSerializer.SerializeToUtf8Bytes(payload, JsonOptions);
        var header = Base64UrlEncode(headerJson);
        var body = Base64UrlEncode(payloadJson);
        var signingInput = $"{header}.{body}";

        try
        {
            using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(media.LiveKit.ApiSecret));
            var signature = Base64UrlEncode(hmac.ComputeHash(Encoding.UTF8.GetBytes(signingInput)));
            return $"{signingInput}.{signature}";
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Could not issue a LiveKit token for room {RoomCode}.", roomCode);
            throw;
        }
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> bytes) =>
        Convert.ToBase64String(bytes)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
}
