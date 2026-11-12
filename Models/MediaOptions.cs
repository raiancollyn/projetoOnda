using System.Text.Json.Serialization;

namespace Onda.Models;

public sealed class MediaOptions
{
    public const string MeshProvider = "Mesh";
    public const string LiveKitProvider = "LiveKit";

    public string Provider { get; set; } = MeshProvider;
    public int MaxParticipants { get; set; } = 8;
    public List<IceServerOptions> IceServers { get; set; } = CreateDefaultIceServers();
    public LiveKitOptions LiveKit { get; set; } = new();

    public bool IsLiveKitConfigured =>
        string.Equals(Provider, LiveKitProvider, StringComparison.OrdinalIgnoreCase) &&
        LiveKit.IsConfigured;

    public string EffectiveProvider => IsLiveKitConfigured ? LiveKitProvider : MeshProvider;

    public int EffectiveMaxParticipants
    {
        get
        {
            var requested = Math.Clamp(MaxParticipants, 2, 100);
            return IsLiveKitConfigured ? requested : Math.Min(requested, 8);
        }
    }

    public void Normalize()
    {
        Provider = string.IsNullOrWhiteSpace(Provider) ? MeshProvider : Provider.Trim();
        MaxParticipants = EffectiveMaxParticipants;
        IceServers = (IceServers ?? [])
            .Where(server => server.Urls.Any(url => !string.IsNullOrWhiteSpace(url)))
            .ToList();

        if (IceServers.Count == 0)
        {
            IceServers = CreateDefaultIceServers();
        }
    }

    public static List<IceServerOptions> CreateDefaultIceServers() =>
    [
        new()
        {
            Urls =
            [
                "stun:stun.l.google.com:19302",
                "stun:stun1.l.google.com:19302"
            ]
        },
        new()
        {
            Urls = ["stun:stun.cloudflare.com:3478"]
        }
    ];
}

public sealed class IceServerOptions
{
    public List<string> Urls { get; set; } = [];
    public string? Username { get; set; }
    public string? Credential { get; set; }
}

public sealed class LiveKitOptions
{
    public string Url { get; set; } = string.Empty;
    public string ApiKey { get; set; } = string.Empty;
    public string ApiSecret { get; set; } = string.Empty;
    public int TokenTtlHours { get; set; } = 6;

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(Url) &&
        !string.IsNullOrWhiteSpace(ApiKey) &&
        !string.IsNullOrWhiteSpace(ApiSecret);
}

/// <summary>
/// User-selectable capture and encoding preferences for screen sharing.
/// The same object shape is consumed by both the P2P and SFU JS media layers.
/// </summary>
public sealed class ScreenShareQuality
{
    public const string PresetFluid = "fluid";
    public const string PresetBalanced = "balanced";
    public const string PresetSharp = "sharp";
    public const string PresetCustom = "custom";

    public string Preset { get; set; } = PresetBalanced;
    public int Height { get; set; } = 1080;
    public int FrameRate { get; set; } = 30;
    public int BitrateKbps { get; set; } = 5000;
    public string Codec { get; set; } = "auto";
    public string ContentMode { get; set; } = "detail";

    [JsonIgnore]
    public int Width => Height <= 0 ? 0 : (int)Math.Round(Height * 16d / 9d / 2d) * 2;

    [JsonIgnore]
    public string Summary => Preset switch
    {
        PresetFluid => "Fluida · 720p · 60 fps",
        PresetSharp => "Nítida · 1440p · 30 fps",
        PresetBalanced => "Equilibrada · 1080p · 30 fps",
        _ => $"{Height}p · {FrameRate} fps · {BitrateKbps / 1000d:0.#} Mbps"
    };

    public ScreenShareQuality Clone() => new()
    {
        Preset = Preset,
        Height = Height,
        FrameRate = FrameRate,
        BitrateKbps = BitrateKbps,
        Codec = Codec,
        ContentMode = ContentMode
    };

    public ScreenShareQuality Normalize()
    {
        Height = Height is 720 or 1080 or 1440 or 2160 ? Height : 1080;
        FrameRate = FrameRate is >= 10 and <= 60 ? FrameRate : 30;
        BitrateKbps = Math.Clamp(BitrateKbps, 800, 20_000);
        Codec = Codec?.Trim().ToLowerInvariant() switch
        {
            "vp8" or "vp9" or "h264" or "av1" => Codec.Trim().ToLowerInvariant(),
            _ => "auto"
        };
        ContentMode = string.Equals(ContentMode, "motion", StringComparison.OrdinalIgnoreCase)
            ? "motion"
            : "detail";
        Preset = Preset is PresetFluid or PresetBalanced or PresetSharp or PresetCustom
            ? Preset
            : PresetCustom;

        return this;
    }

    public static ScreenShareQuality ForPreset(string? preset) => (preset switch
    {
        PresetFluid => new ScreenShareQuality
        {
            Preset = PresetFluid,
            Height = 720,
            FrameRate = 60,
            BitrateKbps = 4000,
            Codec = "auto",
            ContentMode = "motion"
        },
        PresetSharp => new ScreenShareQuality
        {
            Preset = PresetSharp,
            Height = 1440,
            FrameRate = 30,
            BitrateKbps = 9000,
            Codec = "auto",
            ContentMode = "detail"
        },
        PresetCustom => new ScreenShareQuality
        {
            Preset = PresetCustom,
            Height = 1080,
            FrameRate = 30,
            BitrateKbps = 5000,
            Codec = "auto",
            ContentMode = "detail"
        },
        _ => new ScreenShareQuality
        {
            Preset = PresetBalanced,
            Height = 1080,
            FrameRate = 30,
            BitrateKbps = 5000,
            Codec = "auto",
            ContentMode = "detail"
        }
    }).Normalize();

    public override string ToString() => Summary;
}
