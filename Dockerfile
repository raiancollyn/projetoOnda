FROM mcr.microsoft.com/dotnet/sdk:10.0.403 AS build
WORKDIR /src

COPY global.json Onda.csproj ./
RUN dotnet restore Onda.csproj

COPY . .
RUN dotnet publish Onda.csproj -c Release -o /out /p:UseAppHost=false --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0.14 AS runtime
WORKDIR /app

ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    Storage__DatabasePath=/data/onda.db \
    DOTNET_EnableDiagnostics=0

COPY --from=build /out ./
RUN mkdir -p /data && chown "$APP_UID:$APP_UID" /data
EXPOSE 8080

# The base image ships a non-root `app` user and exposes its UID.
USER $APP_UID

ENTRYPOINT ["dotnet", "Onda.dll"]
