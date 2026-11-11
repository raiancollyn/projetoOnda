namespace Onda.Services;

/// <summary>
/// Periodically removes presence ghosts when a browser disappears without a clean leave.
/// </summary>
public sealed class RoomJanitor(RoomService rooms, ILogger<RoomJanitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(25));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                rooms.PurgeStale();
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Normal shutdown.
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "The room janitor stopped unexpectedly.");
        }
    }
}
