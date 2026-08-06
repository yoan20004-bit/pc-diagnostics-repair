--!nonstrict
--[[
	Settings
	Display toggles, code redemption, and a short reference for how luck works.

	The toggles are stored on the profile rather than locally, because a player
	who turns off cinematics after a thousand rolls should not have to do it
	again on their phone.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Format = require(Shared.Format)
local Rarity = require(Shared.Rarity)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local Window = require(script.Parent.Window)
local State = require(script.Parent.Parent.State)

local Settings = {}

local window
local body
local actions
local codeBox

local TOGGLES = {
	{
		key = "cinematics",
		label = "Cinematic reveals",
		description = "Full-screen presentation for Legendary and above.",
	},
	{
		key = "lowEffects",
		label = "Reduced effects",
		description = "Skip particles and camera shake. Recommended on older devices.",
	},
	{
		key = "hideOthersAnnouncements",
		label = "Hide other players' finds",
		description = "Stop server-wide announcements from appearing on your screen.",
	},
}

local function toggleRow(parent: Instance, order: number, entry, enabled: boolean)
	local frame = Create("Frame", {
		LayoutOrder = order,
		Size = UDim2.new(1, 0, 0, 56),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 22,
		Parent = parent,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.5).Parent = frame

	Theme.label({
		Text = entry.label,
		Font = Theme.font.heading,
		TextSize = 14,
		Position = UDim2.fromOffset(14, 9),
		Size = UDim2.new(1, -140, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.label({
		Text = entry.description,
		TextSize = 12,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(14, 28),
		Size = UDim2.new(1, -140, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	Theme.button({
		Text = enabled and "ON" or "OFF",
		TextSize = 13,
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -14, 0.5, 0),
		Size = UDim2.fromOffset(84, 30),
		BackgroundColor3 = enabled and Theme.color.success or Theme.color.panel,
		TextColor3 = enabled and Theme.color.backdrop or Theme.color.subtext,
		ZIndex = 23,
		Parent = frame,
	}, function()
		actions.setSetting(entry.key, not enabled)
	end)
end

function Settings.build(parent: Instance, handlers)
	actions = handlers
	window = Window.new(parent, "More", "Settings, codes and odds")

	local scroller = Create("ScrollingFrame", {
		Position = UDim2.fromOffset(12, 8),
		Size = UDim2.new(1, -24, 1, -20),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.color.stroke,
		ZIndex = 21,
		Parent = window.content,
	})

	local layout = Theme.listLayout(8)
	layout.Parent = scroller
	Theme.autoCanvas(scroller, layout)
	body = scroller

	window.onOpen = function()
		Settings.render()
	end

	return window
end

local function renderCodes(parent: Instance, order: number)
	local frame = Create("Frame", {
		LayoutOrder = order,
		Size = UDim2.new(1, 0, 0, 82),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 22,
		Parent = parent,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.5).Parent = frame

	Theme.label({
		Text = "Redeem a code",
		Font = Theme.font.heading,
		TextSize = 14,
		Position = UDim2.fromOffset(14, 10),
		Size = UDim2.new(1, -28, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	codeBox = Create("TextBox", {
		PlaceholderText = "Enter code",
		Text = "",
		ClearTextOnFocus = false,
		Font = Theme.font.body,
		TextSize = 14,
		TextColor3 = Theme.color.text,
		PlaceholderColor3 = Theme.color.subtext,
		BackgroundColor3 = Theme.color.panel,
		BorderSizePixel = 0,
		Position = UDim2.fromOffset(14, 36),
		Size = UDim2.new(1, -140, 0, 34),
		ZIndex = 23,
		Parent = frame,
		Theme.corner(8),
		Theme.padding(8),
	})

	local function submit()
		local text = codeBox.Text
		if text ~= "" then
			actions.redeem(text)
			codeBox.Text = ""
		end
	end

	codeBox.FocusLost:Connect(function(enterPressed)
		if enterPressed then
			submit()
		end
	end)

	Theme.button({
		Text = "REDEEM",
		TextSize = 13,
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -14, 0, 36),
		Size = UDim2.fromOffset(110, 34),
		BackgroundColor3 = Theme.color.accentDark,
		ZIndex = 23,
		Parent = frame,
	}, submit)
end

local function renderOdds(parent: Instance, order: number, luck: number)
	local frame = Create("Frame", {
		LayoutOrder = order,
		Size = UDim2.new(1, 0, 0, 44 + #Rarity.tiers * 20),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 22,
		Parent = parent,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.5).Parent = frame

	Theme.label({
		Text = `Tier odds at your current luck ({Format.multiplier(luck)})`,
		Font = Theme.font.heading,
		TextSize = 14,
		Position = UDim2.fromOffset(14, 10),
		Size = UDim2.new(1, -28, 0, 18),
		ZIndex = 23,
		Parent = frame,
	})

	for i = #Rarity.tiers, 1, -1 do
		local tier = Rarity.tiers[i]
		local chance = Rarity.tierChance(i, luck)
		local text = chance > 0 and Format.rarity(1 / chance) or "impossible"

		Theme.label({
			Text = string.format(
				'<font color="#%s">%s</font>',
				Theme.rarityColor(tier.id):ToHex(),
				tier.name
			),
			TextSize = 12,
			Position = UDim2.fromOffset(14, 34 + (#Rarity.tiers - i) * 20),
			Size = UDim2.fromOffset(160, 18),
			ZIndex = 23,
			Parent = frame,
		})

		Theme.label({
			Text = `{text}   ({Format.percent(chance, 3)})`,
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			Position = UDim2.fromOffset(180, 34 + (#Rarity.tiers - i) * 20),
			Size = UDim2.new(1, -196, 0, 18),
			ZIndex = 23,
			Parent = frame,
		})
	end
end

function Settings.render()
	if not window or not window.visible then
		return
	end

	local snapshot = State.current
	if not snapshot then
		return
	end

	for _, child in body:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	for order, entry in TOGGLES do
		toggleRow(body, order, entry, snapshot.settings[entry.key] == true)
	end

	renderCodes(body, 50)
	renderOdds(body, 60, snapshot.luck or Config.Luck.Base)

	window:setSubtitle(`Playing v{Config.Version}`)
end

function Settings.toggle()
	if window then
		window:toggle()
	end
end

return Settings
