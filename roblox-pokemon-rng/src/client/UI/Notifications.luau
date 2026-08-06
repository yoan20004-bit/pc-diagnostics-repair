--!nonstrict
--[[
	Notifications
	Toasts (bottom-right) and rare-roll announcements (top-centre).

	Both queues are capped and self-pruning. A player auto-rolling with a stack
	of luck potions can trigger announcements faster than they can read them, so
	the oldest is retired rather than letting the column grow off-screen.
]]

local TweenService = game:GetService("TweenService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Format = require(Shared.Format)
local RollEngine = require(Shared.RollEngine)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)

local Notifications = {}

local MAX_TOASTS = 5
local MAX_ANNOUNCEMENTS = 4
local TOAST_LIFETIME = 4
local ANNOUNCE_LIFETIME = 7

local toastHolder
local announceHolder
local toasts = {}
local announcements = {}

function Notifications.build(parent: Instance)
	toastHolder = Create("Frame", {
		Name = "Toasts",
		AnchorPoint = Vector2.new(1, 1),
		Position = UDim2.new(1, -16, 1, -140),
		Size = UDim2.fromOffset(300, 300),
		BackgroundTransparency = 1,
		ZIndex = 40,
		Parent = parent,
		Create("UIListLayout", {
			Padding = UDim.new(0, 6),
			SortOrder = Enum.SortOrder.LayoutOrder,
			HorizontalAlignment = Enum.HorizontalAlignment.Right,
			VerticalAlignment = Enum.VerticalAlignment.Bottom,
		}),
	})

	announceHolder = Create("Frame", {
		Name = "Announcements",
		AnchorPoint = Vector2.new(0.5, 0),
		Position = UDim2.new(0.5, 0, 0, 12),
		Size = UDim2.fromOffset(560, 200),
		BackgroundTransparency = 1,
		ZIndex = 40,
		Parent = parent,
		Create("UIListLayout", {
			Padding = UDim.new(0, 6),
			SortOrder = Enum.SortOrder.LayoutOrder,
			HorizontalAlignment = Enum.HorizontalAlignment.Center,
			VerticalAlignment = Enum.VerticalAlignment.Top,
		}),
	})
end

local function retire(frame: Instance, list: { any })
	local index = table.find(list, frame)
	if index then
		table.remove(list, index)
	end

	local tween = TweenService:Create(
		frame,
		TweenInfo.new(0.2, Enum.EasingStyle.Quad, Enum.EasingDirection.In),
		{ BackgroundTransparency = 1 }
	)
	tween.Completed:Connect(function()
		frame:Destroy()
	end)
	tween:Play()

	for _, child in frame:GetDescendants() do
		if child:IsA("TextLabel") then
			TweenService:Create(child, TweenInfo.new(0.2), { TextTransparency = 1 }):Play()
		end
	end
end

function Notifications.toast(text: string, kind: string?)
	if not toastHolder then
		return
	end

	local accent = Theme.color.accent
	if kind == "success" then
		accent = Theme.color.success
	elseif kind == "error" then
		accent = Theme.color.error
	elseif kind == "warning" then
		accent = Theme.color.warning
	end

	local frame = Create("Frame", {
		Size = UDim2.new(1, 0, 0, 0),
		AutomaticSize = Enum.AutomaticSize.Y,
		BackgroundColor3 = Theme.color.panel,
		BorderSizePixel = 0,
		BackgroundTransparency = 0.05,
		ZIndex = 41,
		LayoutOrder = os.clock() * 1000 // 1,
		Parent = toastHolder,
	})
	Theme.corner(8).Parent = frame
	Theme.stroke(accent, 1.5, 0.3).Parent = frame

	Create("Frame", {
		Size = UDim2.new(0, 4, 1, 0),
		BackgroundColor3 = accent,
		BorderSizePixel = 0,
		ZIndex = 42,
		Parent = frame,
	})

	Theme.label({
		Text = text,
		TextSize = 14,
		TextWrapped = true,
		AutomaticSize = Enum.AutomaticSize.Y,
		Position = UDim2.fromOffset(14, 0),
		Size = UDim2.new(1, -22, 0, 0),
		ZIndex = 42,
		Parent = frame,
		Create("UIPadding", {
			PaddingTop = UDim.new(0, 10),
			PaddingBottom = UDim.new(0, 10),
			PaddingRight = UDim.new(0, 6),
		}),
	})

	table.insert(toasts, frame)
	while #toasts > MAX_TOASTS do
		retire(toasts[1], toasts)
	end

	task.delay(TOAST_LIFETIME, function()
		if frame.Parent then
			retire(frame, toasts)
		end
	end)
end

function Notifications.announce(payload: any)
	if not announceHolder then
		return
	end

	local color = Theme.rarityGlow(payload.tier)

	local frame = Create("Frame", {
		Size = UDim2.new(1, 0, 0, 40),
		BackgroundColor3 = Theme.color.panel,
		BackgroundTransparency = 0.08,
		BorderSizePixel = 0,
		ZIndex = 41,
		LayoutOrder = os.clock() * 1000 // 1,
		Parent = announceHolder,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(color, 2, 0.15).Parent = frame

	local variantName = RollEngine.variantDisplayName(payload.variantKey or "")
	local creature = variantName ~= "" and `{variantName} {payload.name}` or payload.name

	Theme.label({
		Text = string.format(
			'<b>%s</b> found <font color="#%s"><b>%s</b></font>  ·  %s',
			payload.playerName,
			color:ToHex(),
			creature,
			Format.rarity(payload.rarity)
		),
		TextSize = 15,
		TextXAlignment = Enum.TextXAlignment.Center,
		Size = UDim2.fromScale(1, 1),
		ZIndex = 42,
		Parent = frame,
	})

	table.insert(announcements, frame)
	while #announcements > MAX_ANNOUNCEMENTS do
		retire(announcements[1], announcements)
	end

	task.delay(ANNOUNCE_LIFETIME, function()
		if frame.Parent then
			retire(frame, announcements)
		end
	end)
end

return Notifications
