using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace Onda.Services;

/// <summary>
/// Server-side guest identity persisted by an opaque browser cookie.
/// Keeping the identity stable across Blazor circuits preserves room ownership,
/// display name and presence while the WebView is suspended.
/// </summary>
public sealed class GuestIdentityStore
{
    public const string CookieName = "onda_guest";

    private readonly ConcurrentDictionary<string, GuestIdentityState> _identities =
        new(StringComparer.Ordinal);

    public GuestIdentity CreateForNewToken(out string token)
    {
        token = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        return Create(token);
    }

    public GuestIdentity GetOrCreate(string token)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return CreateTransient();
        }

        return _identities.GetOrAdd(token, _ => CreateState()).ToView();
    }

    public GuestIdentity CreateTransient() => CreateState().ToView();

    public void UpdateName(string? token, string name)
    {
        if (!string.IsNullOrWhiteSpace(token) &&
            _identities.TryGetValue(token, out var identity))
        {
            identity.Name = name;
        }
    }

    public void UpdateIdentity(string? token, string name, int avatarTone)
    {
        if (!string.IsNullOrWhiteSpace(token) &&
            _identities.TryGetValue(token, out var identity))
        {
            identity.Name = name;
            identity.AvatarTone = Math.Clamp(avatarTone, 0, GuestSession.AvatarToneCount - 1);
        }
    }

    private GuestIdentity Create(string token)
    {
        var state = CreateState();
        _identities[token] = state;
        return state.ToView();
    }

    private static GuestIdentityState CreateState() => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = $"Convidado {Random.Shared.Next(100, 1000)}",
        AvatarTone = Random.Shared.Next(0, GuestSession.AvatarToneCount)
    };

    private sealed class GuestIdentityState
    {
        public required string Id { get; init; }
        public required string Name { get; set; }
        public required int AvatarTone { get; set; }
        public GuestIdentity ToView() => new(Id, Name, AvatarTone);
    }
}

public sealed record GuestIdentity(string Id, string Name, int AvatarTone);