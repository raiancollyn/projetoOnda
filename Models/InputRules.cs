using System.Text.RegularExpressions;

namespace Onda.Models;

public static partial class InputRules
{
    public const int MaxDisplayNameLength = 32;
    public const int MaxRoomNameLength = 48;
    public const int MinPasswordLength = 4;
    public const int MaxPasswordLength = 64;
    public const int MaxChatLength = 1000;

    public static bool TryNormalizeDisplayName(string? raw, out string value, out string? error)
    {
        value = string.Empty;
        error = null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            error = "Digite um nome para continuar.";
            return false;
        }

        var normalized = CollapseWhitespace(raw);
        if (normalized.Length < 2)
        {
            error = "Use pelo menos 2 caracteres.";
            return false;
        }

        if (normalized.Length > MaxDisplayNameLength)
        {
            error = $"O nome pode ter no máximo {MaxDisplayNameLength} caracteres.";
            return false;
        }

        value = normalized;
        return true;
    }

    public static bool TryNormalizeRoomName(string? raw, out string value, out string? error)
    {
        value = string.Empty;
        error = null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            error = "Dê um nome para a sua sala.";
            return false;
        }

        var normalized = CollapseWhitespace(raw);
        if (normalized.Length > MaxRoomNameLength)
        {
            error = $"O nome da sala pode ter no máximo {MaxRoomNameLength} caracteres.";
            return false;
        }

        value = normalized;
        return true;
    }

    public static bool TryNormalizePassword(string? raw, out string value, out string? error)
    {
        value = string.Empty;
        error = null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            error = "Digite a senha da sala.";
            return false;
        }

        var normalized = raw.Trim();
        if (normalized.Length < MinPasswordLength)
        {
            error = $"A senha precisa ter pelo menos {MinPasswordLength} caracteres.";
            return false;
        }

        if (normalized.Length > MaxPasswordLength)
        {
            error = $"A senha pode ter no máximo {MaxPasswordLength} caracteres.";
            return false;
        }

        value = normalized;
        return true;
    }

    public static bool TryNormalizeChat(string? raw, out string value, out string? error)
    {
        value = string.Empty;
        error = null;

        if (string.IsNullOrWhiteSpace(raw))
        {
            error = "Escreva uma mensagem.";
            return false;
        }

        var normalized = raw.ReplaceLineEndings("\n").Trim();
        if (normalized.Length > MaxChatLength)
        {
            error = $"A mensagem pode ter no máximo {MaxChatLength} caracteres.";
            return false;
        }

        value = normalized;
        return true;
    }

    /// <summary>
    /// Accepts a bare code or a full room URL and returns the code.
    /// </summary>
    public static string? NormalizeRoomCode(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        var value = raw.Trim();
        var queryIndex = value.IndexOfAny(['?', '#']);
        if (queryIndex >= 0)
        {
            value = value[..queryIndex];
        }

        value = value.TrimEnd('/');
        var slashIndex = value.LastIndexOf('/');
        if (slashIndex >= 0)
        {
            value = value[(slashIndex + 1)..];
        }

        value = value.ToLowerInvariant();
        return RoomCodePattern().IsMatch(value) ? value : null;
    }

    public static string CollapseWhitespace(string value)
    {
        var pieces = value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        return string.Join(' ', pieces);
    }

    [GeneratedRegex("^[a-z0-9]{4,12}$", RegexOptions.CultureInvariant)]
    private static partial Regex RoomCodePattern();
}
