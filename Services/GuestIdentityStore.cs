using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Onda.Models;

namespace Onda.Services;

/// <summary>
/// Server-side guest identity persisted by an opaque browser cookie.
/// Keeping the identity stable across Blazor circuits and process restarts
/// preserves room ownership, display name and presence.
/// </summary>
public sealed class GuestIdentityStore
{
    public const string CookieName = "onda_guest";

    private readonly ConcurrentDictionary<string, GuestIdentityState> _identities =
        new(StringComparer.Ordinal);
    private readonly ChatStore _chatStore;
    private readonly TimeProvider _time;
    private readonly object _writeLock = new();

    public GuestIdentityStore(ChatStore chatStore, TimeProvider time)
    {
        _chatStore = chatStore;
        _time = time;
    }

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

        if (_identities.TryGetValue(token, out var cached))
        {
            return cached.ToView();
        }

        var tokenHash = HashToken(token);
        PersistedGuestIdentity? persisted = null;
        try
        {
            persisted = _chatStore.GetGuestIdentity(tokenHash);
        }
        catch
        {
            // Persistence is an enhancement; identity still works in memory.
        }

        var candidate = persisted is null
            ? CreateState(tokenHash)
            : new GuestIdentityState
            {
                Id = persisted.GuestId,
                Name = persisted.Name,
                AvatarTone = Math.Clamp(persisted.AvatarTone, 0, GuestSession.AvatarToneCount - 1),
                TokenHash = tokenHash
            };

        var actual = _identities.GetOrAdd(token, candidate);
        Persist(actual);
        return actual.ToView();
    }

    public GuestIdentity CreateTransient() => CreateState(null).ToView();

    public void UpdateName(string? token, string name)
    {
        if (string.IsNullOrWhiteSpace(token) ||
            !_identities.TryGetValue(token, out var identity))
        {
            return;
        }

        identity.Name = name;
        Persist(identity);
    }

    public void UpdateIdentity(string? token, string name, int avatarTone)
    {
        if (string.IsNullOrWhiteSpace(token) ||
            !_identities.TryGetValue(token, out var identity))
        {
            return;
        }

        identity.Name = name;
        identity.AvatarTone = Math.Clamp(avatarTone, 0, GuestSession.AvatarToneCount - 1);
        Persist(identity);
    }

    private GuestIdentity Create(string token)
    {
        var state = CreateState(HashToken(token));
        _identities[token] = state;
        Persist(state);
        return state.ToView();
    }

    private static GuestIdentityState CreateState(string? tokenHash) => new()
    {
        Id = Guid.NewGuid().ToString("N"),
        Name = $"Convidado {Random.Shared.Next(100, 1000)}",
        AvatarTone = Random.Shared.Next(0, GuestSession.AvatarToneCount),
        TokenHash = tokenHash
    };

    private void Persist(GuestIdentityState state)
    {
        if (string.IsNullOrWhiteSpace(state.TokenHash))
        {
            return;
        }

        try
        {
            lock (_writeLock)
            {
                _chatStore.UpsertGuestIdentity(
                    state.TokenHash,
                    state.Id,
                    state.Name,
                    state.AvatarTone,
                    _time.GetUtcNow());
            }
        }
        catch
        {
            // The in-memory identity remains valid for the current process.
        }
    }

    private static string HashToken(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private sealed class GuestIdentityState
    {
        public required string Id { get; init; }
        public required string Name { get; set; }
        public required int AvatarTone { get; set; }
        public string? TokenHash { get; init; }
        public GuestIdentity ToView() => new(Id, Name, AvatarTone);
    }
}

public sealed record GuestIdentity(string Id, string Name, int AvatarTone);
