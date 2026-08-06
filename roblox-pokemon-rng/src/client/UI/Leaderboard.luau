--!nonstrict
--[[
	Leaderboard
	Global top-25 boards, mirroring the two physical pillars in the world.

	The payload arrives on a server-wide timer rather than per player, so this
	panel renders whatever the last broadcast contained and shows how old it is
	instead of pretending to be live.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Format = require(Shared.Format)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local Window = require(script.Parent.Window)
local State = require(script.Parent.Parent.State)

local Leaderboard = {}

local window
local rarestList
local rollsList

local function column(parent: Instance, title: string, xScale: number)
	local frame = Create("Frame", {
		Position = UDim2.new(xScale, xScale == 0 and 12 or 6, 0, 8),
		Size = UDim2.new(0.5, -18, 1, -20),
		BackgroundColor3 = Theme.color.panelAlt,
		BorderSizePixel = 0,
		ZIndex = 21,
		Parent = parent,
	})
	Theme.corner(10).Parent = frame
	Theme.stroke(Theme.color.stroke, 1, 0.5).Parent = frame

	Theme.label({
		Text = title,
		Font = Theme.font.heading,
		TextSize = 14,
		TextXAlignment = Enum.TextXAlignment.Center,
		Position = UDim2.fromOffset(0, 8),
		Size = UDim2.new(1, 0, 0, 20),
		ZIndex = 22,
		Parent = frame,
	})

	local scroller = Create("ScrollingFrame", {
		Position = UDim2.fromOffset(8, 32),
		Size = UDim2.new(1, -16, 1, -42),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		ScrollBarThickness = 5,
		ScrollBarImageColor3 = Theme.color.stroke,
		ZIndex = 22,
		Parent = frame,
	})

	local layout = Theme.listLayout(3)
	layout.Parent = scroller
	Theme.autoCanvas(scroller, layout)

	return scroller
end

local function rankColor(rank: number): Color3
	if rank == 1 then
		return Color3.fromRGB(255, 214, 84)
	elseif rank == 2 then
		return Color3.fromRGB(206, 214, 232)
	elseif rank == 3 then
		return Color3.fromRGB(214, 152, 96)
	end
	return Theme.color.subtext
end

function Leaderboard.build(parent: Instance)
	window = Window.new(parent, "Leaderboard", "Refreshed once a minute")

	rarestList = column(window.content, "RAREST FINDS", 0)
	rollsList = column(window.content, "MOST ROLLS", 0.5)

	window.onOpen = function()
		Leaderboard.render()
	end

	State.LeaderboardChanged:Connect(function()
		Leaderboard.render()
	end)

	return window
end

function Leaderboard.render()
	if not window or not window.visible then
		return
	end

	local data = State.leaderboard

	for _, child in rarestList:GetChildren() do
		if child:IsA("TextLabel") then
			child:Destroy()
		end
	end
	for _, child in rollsList:GetChildren() do
		if child:IsA("TextLabel") then
			child:Destroy()
		end
	end

	if #data.rarest == 0 then
		Theme.label({
			Text = "No entries yet — be the first.",
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			Size = UDim2.new(1, 0, 0, 20),
			ZIndex = 23,
			Parent = rarestList,
		})
	end

	for _, entry in data.rarest do
		local species = entry.speciesId and Species.byId[entry.speciesId]
		local color = species and Theme.rarityGlow(species.tier) or Theme.color.text
		local variantName = RollEngine.variantDisplayName(entry.variantKey or "")
		local creature = species and species.name or "?"
		if variantName ~= "" then
			creature = `{variantName} {creature}`
		end

		Theme.label({
			Text = string.format(
				'<font color="#%s">%d.</font> %s<br/><font color="#%s">%s</font> <font color="#7A8298">%s</font>',
				rankColor(entry.rank):ToHex(),
				entry.rank,
				entry.name,
				color:ToHex(),
				creature,
				Format.rarity(entry.rarity)
			),
			TextSize = 12,
			LayoutOrder = entry.rank,
			Size = UDim2.new(1, 0, 0, 34),
			ZIndex = 23,
			Parent = rarestList,
		})
	end

	if #data.rolls == 0 then
		Theme.label({
			Text = "No entries yet.",
			TextSize = 12,
			TextColor3 = Theme.color.subtext,
			Size = UDim2.new(1, 0, 0, 20),
			ZIndex = 23,
			Parent = rollsList,
		})
	end

	for _, entry in data.rolls do
		Theme.label({
			Text = string.format(
				'<font color="#%s">%d.</font> User %d<br/><font color="#7A8298">%s rolls</font>',
				rankColor(entry.rank):ToHex(),
				entry.rank,
				entry.userId,
				Format.comma(entry.rolls)
			),
			TextSize = 12,
			LayoutOrder = entry.rank,
			Size = UDim2.new(1, 0, 0, 34),
			ZIndex = 23,
			Parent = rollsList,
		})
	end

	local snapshot = State.current
	if snapshot and snapshot.best then
		local species = Species.byId[snapshot.best.speciesId]
		local variantName = RollEngine.variantDisplayName(snapshot.best.variantKey or "")
		local creature = species and species.name or "?"
		if variantName ~= "" then
			creature = `{variantName} {creature}`
		end
		window:setSubtitle(`Your best: {creature} ({Format.rarity(snapshot.best.rarity)})`)
	else
		window:setSubtitle("Refreshed once a minute")
	end
end

function Leaderboard.toggle()
	if window then
		window:toggle()
	end
end

return Leaderboard
