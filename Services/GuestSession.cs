using Onda.Models;

namespace Onda.Services;

/// <summary>
/// Identity for one interactive browser session (one Blazor circuit).
/// </summary>
public sealed class GuestSession
{
    public const int AvatarToneCount = 6;

    public GuestSession()
    {
        Id = Guid.NewGuid().ToString("N");
        Name = $"Convidado {Random.Shared.Next(100, 1000)}";
        AvatarTone = Random.Shared.Next(0, AvatarToneCount);
    }

    public string Id { get; }
    public string Name { get; private set; }
    public int AvatarTone { get; }

    public bool TrySetName(string? rawName, out string? error)
    {
        if (!InputRules.TryNormalizeDisplayName(rawName, out var normalized, out error))
        {
            return false;
        }

        Name = normalized;
        return true;
    }
}
