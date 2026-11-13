using Onda.Models;

namespace Onda.Services;

/// <summary>
/// Identity for one interactive browser session (one Blazor circuit).
/// The opaque cookie token keeps the identity stable across reconnects.
/// </summary>
public sealed class GuestSession
{
    public const int AvatarToneCount = 6;

    private readonly GuestIdentityStore _identities;
    private readonly string? _token;

    public GuestSession(IHttpContextAccessor httpContextAccessor, GuestIdentityStore identities)
    {
        _identities = identities;
        var context = httpContextAccessor.HttpContext;
        _token = context?.Items[GuestIdentityStore.CookieName] as string
            ?? context?.Request.Cookies[GuestIdentityStore.CookieName];

        var identity = string.IsNullOrWhiteSpace(_token)
            ? _identities.CreateTransient()
            : _identities.GetOrCreate(_token);

        Id = identity.Id;
        Name = identity.Name;
        AvatarTone = identity.AvatarTone;
    }

    public string Id { get; }
    public string Name { get; private set; }
    public int AvatarTone { get; private set; }

    public void RestoreHandoffIdentity(string name, int avatarTone)
    {
        if (!string.IsNullOrWhiteSpace(name))
        {
            Name = name.Trim();
        }

        AvatarTone = Math.Clamp(avatarTone, 0, AvatarToneCount - 1);
        _identities.UpdateIdentity(_token, Name, AvatarTone);
    }

    public bool TrySetName(string? rawName, out string? error)
    {
        if (!InputRules.TryNormalizeDisplayName(rawName, out var normalized, out error))
        {
            return false;
        }

        Name = normalized;
        _identities.UpdateName(_token, Name);
        return true;
    }
}