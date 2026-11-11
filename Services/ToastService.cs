namespace Onda.Services;

public enum ToastKind
{
    Info,
    Success,
    Error
}

public sealed record ToastMessage(Guid Id, string Message, ToastKind Kind, DateTimeOffset CreatedAt);

/// <summary>
/// Scoped toast queue. Each browser circuit has its own host.
/// </summary>
public sealed class ToastService
{
    private readonly object _sync = new();
    private readonly List<ToastMessage> _messages = [];

    public event Action? Changed;

    public IReadOnlyList<ToastMessage> Messages
    {
        get
        {
            lock (_sync)
            {
                return _messages.ToArray();
            }
        }
    }

    public Guid Show(string message, ToastKind kind = ToastKind.Info, int autoDismissMs = 4200)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return Guid.Empty;
        }

        var toast = new ToastMessage(Guid.NewGuid(), message.Trim(), kind, DateTimeOffset.UtcNow);
        lock (_sync)
        {
            _messages.Add(toast);
            if (_messages.Count > 3)
            {
                _messages.RemoveAt(0);
            }
        }

        Changed?.Invoke();

        if (autoDismissMs > 0)
        {
            _ = AutoDismissAsync(toast.Id, autoDismissMs);
        }

        return toast.Id;
    }

    public void Dismiss(Guid id)
    {
        var removed = false;
        lock (_sync)
        {
            removed = _messages.RemoveAll(t => t.Id == id) > 0;
        }

        if (removed)
        {
            Changed?.Invoke();
        }
    }

    private async Task AutoDismissAsync(Guid id, int delayMs)
    {
        try
        {
            await Task.Delay(delayMs);
            Dismiss(id);
        }
        catch
        {
            // Scoped service may be going away with the circuit.
        }
    }
}
