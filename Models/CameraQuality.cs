
using System.Text.Json.Serialization;

namespace Onda.Models;

/// <summary>
/// Capture and encoding preferences for the webcam. Kept separate from
/// <see cref="ScreenShareQuality"/> so changing a screen preset does not
/// alter the camera and vice versa.
/// </summary>
public sealed class CameraQuality
{
    public int Height { get; set; } = 720;
    public int FrameRate { get; set; } = 30;
    public int BitrateKbps { get; set; } = 1500;

    [JsonIgnore]
    public int Width => Height <= 0 ? 0 : (int)Math.Round(Height * 16d / 9d / 2d) * 2;

    [JsonIgnore]
    public string Summary => $"{Height}p · {FrameRate} fps · {BitrateKbps / 1000d:0.#} Mbps";

    public CameraQuality Clone() => new()
    {
        Height = Height,
        FrameRate = FrameRate,
        BitrateKbps = BitrateKbps
    };

    public CameraQuality Normalize()
    {
        Height = Height is 480 or 720 or 1080 or 1440 or 2160 ? Height : 720;
        FrameRate = FrameRate is >= 10 and <= 60 ? FrameRate : 30;
        BitrateKbps = Math.Clamp(BitrateKbps, 300, 12_000);
        return this;
    }

    public override string ToString() => Summary;
}
