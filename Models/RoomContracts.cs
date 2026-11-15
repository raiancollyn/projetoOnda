namespace Onda.Models;

public sealed record ParticipantView(
    string Id,
    string Name,
    int ColorIndex,
    bool IsOwner,
    bool MicOn,
    bool CameraOn,
    bool ScreenOn,
    bool ScreenWithAudio,
    bool Speaking,
    DateTimeOffset JoinedAt,
    bool IsPunished = false,
    DateTimeOffset? PunishedUntil = null,
    bool MicBlocked = false,
    bool CameraBlocked = false,
    bool ScreenBlocked = false,
    bool ChatBlocked = false,
    bool ScreenAudioBlocked = false);

public sealed record ChatMessageView(
    string Id,
    string? SenderId,
    string SenderName,
    string Text,
    DateTimeOffset SentAt,
    bool IsSystem);

public sealed record RoomView(
    string Id,
    string Name,
    bool HasPassword,
    int MaxParticipants,
    DateTimeOffset CreatedAt,
    string OwnerName,
    IReadOnlyList<ParticipantView> Participants,
    IReadOnlyList<ChatMessageView> Messages);

public sealed record RoomPersonView(string Name, int ColorIndex, bool Speaking);

public sealed record RoomSummaryView(
    string Id,
    string Name,
    bool HasPassword,
    int ParticipantCount,
    int MaxParticipants,
    DateTimeOffset CreatedAt,
    string OwnerName,
    IReadOnlyList<RoomPersonView> People);

public sealed record RoomInfoView(
    string Id,
    string Name,
    bool HasPassword,
    bool RequiresPassword,
    bool IsFull,
    bool IsOwner,
    int ParticipantCount,
    int MaxParticipants,
    string OwnerName);

public sealed record RelaySignal(string RoomId, string FromId, string ToId, string Payload);

public sealed record RoomBanView(
    string Id,
    string GuestName,
    string Reason,
    DateTimeOffset BannedAt,
    DateTimeOffset? ExpiresAt,
    string BannedByName,
    string DeviceId,
    bool Permanent);

public sealed record ModerationNoticeView(
    string Kind,
    string? Reason,
    DateTimeOffset? Until,
    bool Permanent);

public enum JoinRoomStatus
{
    Success,
    NotFound,
    WrongPassword,
    Full,
    InvalidInput,
    Banned
}

public sealed record JoinRoomResult(
    JoinRoomStatus Status,
    string? Error,
    RoomView? Room,
    RoomBanView? Ban = null);

public sealed record CreateRoomResult(bool Success, string? RoomCode, string? Error);

public sealed record CreateHandoffResult(bool Success, string? Token, string? Error);

public sealed record RedeemHandoffResult(bool Success, string? Name, int AvatarTone, string? Error);
