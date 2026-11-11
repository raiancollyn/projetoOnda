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
    DateTimeOffset JoinedAt);

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

public enum JoinRoomStatus
{
    Success,
    NotFound,
    WrongPassword,
    Full,
    InvalidInput
}

public sealed record JoinRoomResult(JoinRoomStatus Status, string? Error, RoomView? Room);

public sealed record CreateRoomResult(bool Success, string? RoomCode, string? Error);
