namespace Onda.Services;

/// <summary>
/// Removes stale presence and deletes persisted rooms that have been empty for
/// longer than the room grace period.
/// </summary>
public sealed class RoomJanitor(RoomService rooms, ILogger<RoomJanitor> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
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
