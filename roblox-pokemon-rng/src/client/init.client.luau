--!nonstrict
--[[
	PokeRNG -- client bootstrap.

	Builds the interface, wires every remote to it, and turns UI intent into
	remote calls. There is no game logic here at all: the client asks, renders
	what it is told, and animates. Every number it displays came from the server.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("PokeRNG")
local Net = require(Shared.Net)

local State = require(script.State)
local Create = require(script.UI.Create)
local Window = require(script.UI.Window)
local HUD = require(script.UI.HUD)
local Effects = require(script.UI.Effects)
local Notifications = require(script.UI.Notifications)
local Inventory = require(script.UI.Inventory)
local Index = require(script.UI.Index)
local Shop = require(script.UI.Shop)
local Leaderboard = require(script.UI.Leaderboard)
local Settings = require(script.UI.Settings)

local player = Players.LocalPlayer
local playerGui = player:WaitForChild("PlayerGui")

--------------------------------------------------------------------------------
-- Remotes
--------------------------------------------------------------------------------

local remotes = {
	StateSync = Net.get(Net.ToClient.StateSync),
	RollResult = Net.get(Net.ToClient.RollResult),
	Notify = Net.get(Net.ToClient.Notify),
	Announce = Net.get(Net.ToClient.Announce),
	LeaderboardSync = Net.get(Net.ToClient.LeaderboardSync),

	RequestRoll = Net.get(Net.ToServer.RequestRoll),
	SetAutoRoll = Net.get(Net.ToServer.SetAutoRoll),
	EquipBuddy = Net.get(Net.ToServer.EquipBuddy),
	SellDuplicates = Net.get(Net.ToServer.SellDuplicates),
	BuyUpgrade = Net.get(Net.ToServer.BuyUpgrade),
	BuyPotion = Net.get(Net.ToServer.BuyPotion),
	Prestige = Net.get(Net.ToServer.Prestige),
	UpdateSetting = Net.get(Net.ToServer.UpdateSetting),
	ClaimDaily = Net.get(Net.ToServer.ClaimDaily),
	RedeemCode = Net.get(Net.ToServer.RedeemCode),
	PromptPurchase = Net.get(Net.ToServer.PromptPurchase),
}

--------------------------------------------------------------------------------
-- Screen
--------------------------------------------------------------------------------

local screen = Create("ScreenGui", {
	Name = "PokeRNG",
	ResetOnSpawn = false,
	IgnoreGuiInset = true,
	ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	Parent = playerGui,
})

--------------------------------------------------------------------------------
-- Actions -- the only place the client talks back to the server
--------------------------------------------------------------------------------

local actions = {}

function actions.roll()
	-- The server enforces the cooldown; this check only avoids sending traffic
	-- we already know will be discarded.
	if not HUD.canRoll() then
		return
	end
	remotes.RequestRoll:FireServer()
end

function actions.toggleAuto(enabled: boolean)
	remotes.SetAutoRoll:FireServer(enabled)
end

function actions.equip(speciesId: number?, variantKey: string?)
	remotes.EquipBuddy:FireServer(speciesId, variantKey)
end

function actions.sell(keep: number)
	remotes.SellDuplicates:FireServer(keep)
end

function actions.buyUpgrade(upgradeId: string)
	remotes.BuyUpgrade:FireServer(upgradeId)
end

function actions.buyPotion(potionId: string, mode: string)
	remotes.BuyPotion:FireServer(potionId, mode)
end

function actions.prestige()
	remotes.Prestige:FireServer()
end

function actions.setSetting(key: string, value: boolean)
	remotes.UpdateSetting:FireServer(key, value)
end

function actions.redeem(code: string)
	remotes.RedeemCode:FireServer(code)
end

function actions.prompt(kind: string, key: string)
	remotes.PromptPurchase:FireServer(kind, key)
end

function actions.nav(key: string)
	if key == "bag" then
		Inventory.toggle()
	elseif key == "index" then
		Index.toggle()
	elseif key == "shop" then
		Shop.toggle()
	elseif key == "board" then
		Leaderboard.toggle()
	elseif key == "settings" then
		Settings.toggle()
	elseif key == "daily" then
		remotes.ClaimDaily:FireServer()
	end
end

--------------------------------------------------------------------------------
-- Build
--------------------------------------------------------------------------------

Notifications.build(screen)
Effects.build(screen)
HUD.build(screen, actions)

Inventory.build(screen, actions)
Index.build(screen)
Shop.build(screen, actions)
Leaderboard.build(screen)
Settings.build(screen, actions)

--------------------------------------------------------------------------------
-- Wiring
--------------------------------------------------------------------------------

remotes.StateSync.OnClientEvent:Connect(function(snapshot)
	State.apply(snapshot)
end)

remotes.RollResult.OnClientEvent:Connect(function(result)
	State.pushRoll(result)
	HUD.onRoll(result)
	Effects.reveal(result)
end)

remotes.Notify.OnClientEvent:Connect(function(payload)
	Notifications.toast(payload.text, payload.kind)
end)

remotes.Announce.OnClientEvent:Connect(function(payload)
	Notifications.announce(payload)
end)

remotes.LeaderboardSync.OnClientEvent:Connect(function(data)
	State.applyLeaderboard(data)
end)

-- Panels re-render on every state change, but only if they are open. A closed
-- panel re-renders when it opens, so this stays cheap during an auto-roll storm.
State.Changed:Connect(function(snapshot)
	HUD.render(snapshot)
	Inventory.render()
	Index.render()
	Shop.render()
	Leaderboard.render()
	Settings.render()
end)

-- Escape closes whatever panel is open, which is what players expect and what
-- Roblox's own menu does not do for custom UI.
local UserInputService = game:GetService("UserInputService")
UserInputService.InputBegan:Connect(function(input, processed)
	if processed then
		return
	end
	if input.KeyCode == Enum.KeyCode.Escape then
		Window.closeAll()
	end
end)
