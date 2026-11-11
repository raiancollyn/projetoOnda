namespace Onda.Models;

/// <summary>
/// Durable storage for room metadata and chat. The database belongs to the
/// app instance; empty rooms are removed from both memory and disk.
/// </summary>
public sealed class StorageOptions
{
    public string DatabasePath { get; set; } = Path.Combine("Data", "onda.db");
}
